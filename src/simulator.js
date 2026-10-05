'use strict';

const mulberry32 = require('./prng');
const Ledger = require('./ledger');
const Terminal = require('./terminal');
const Scheduler = require('./scheduler');
const { LossyChannel } = require('./channel');
const { ProtocolError } = require('./errors');
const { validateCommand } = require('./validate');

function normalizeOps(doc) {
  const ops = Array.isArray(doc) ? doc : doc && Array.isArray(doc.ops) ? doc.ops : null;
  if (!ops) throw new ProtocolError('ops document must be an array or { "ops": [...] }');
  return ops;
}

function byStartThenId(a, b) {
  if (a.start !== b.start) return a.start - b.start;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function buildReport({ ledger, scheduler, terminal, channel, time, failure, remaining }) {
  const plan = [...ledger.jobs.values()]
    .map((j) => ({ id: j.id, start: j.start, end: j.end, cost: j.cost, ver: j.ver }))
    .sort(byStartThenId); // ties broken by (start, id) lexicographic order
  return {
    ok: !failure,
    failure,
    cap: ledger.cap,
    used: ledger.used,
    plan,
    ledger: ledger.entries.map((e) => ({ ...e })),
    pending: scheduler.pendingQueue(),
    remaining,
    stats: {
      time,
      sent: scheduler.stats.sent,
      retransmissions: scheduler.stats.retransmissions,
      duplicateAcks: scheduler.stats.duplicateAcks,
      terminal: { ...terminal.stats },
      channel: { ...channel.stats },
    },
  };
}

// Run the full confirmation protocol over a (possibly lossy) channel.
// Options: { cap, seed, loss, baseTimeout, maxRetries, channel }.
// On a budget NAK the run stops; the failed command leaves no trace
// (state unchanged). Protocol violations throw ProtocolError with a
// partial report attached as err.report.
function run(doc, opts = {}) {
  const ops = normalizeOps(doc);
  const cap = opts.cap;
  if (!Number.isFinite(cap) || cap < 0) throw new ProtocolError(`invalid cap: ${cap}`);
  const channel =
    opts.channel || new LossyChannel(mulberry32(opts.seed ?? 1), opts.loss ?? 0);
  const ledger = new Ledger(cap);
  const terminal = new Terminal(ledger);
  const scheduler = new Scheduler({
    baseTimeout: opts.baseTimeout ?? 4,
    maxRetries: opts.maxRetries ?? 8,
  });

  let time = 0;
  let failure = null;
  let index = 0;

  const partial = (remainingFrom) =>
    buildReport({
      ledger, scheduler, terminal, channel, time, failure,
      remaining: ops.slice(remainingFrom),
    });

  try {
    for (index = 0; index < ops.length; index++) {
      const cmd = validateCommand(ops[index]);
      scheduler.dispatch(cmd);
      for (;;) {
        const delivered = channel.transmit({ dir: 'cmd', ...cmd });
        let reply = null;
        if (delivered) {
          reply = terminal.receive(cmd); // null: stale ver, ignored
          if (reply && !channel.transmit({ dir: 'ack', ...reply })) {
            reply = null; // ACK lost: scheduler will retransmit
          }
        }
        if (reply) {
          const outcome = scheduler.onReply(reply);
          if (outcome.ignored) continue;
          if (outcome.confirmed) break;
          failure = { type: 'budget', cmd, reason: outcome.reason };
          break;
        }
        time += scheduler.pending.timeout;
        scheduler.onTimeout(); // throws ProtocolError past maxRetries
      }
      if (failure) break;
    }
  } catch (err) {
    if (err instanceof ProtocolError) {
      err.report = partial(index);
    }
    throw err;
  }

  return partial(failure ? index : ops.length);
}

module.exports = { run, normalizeOps, byStartThenId };
