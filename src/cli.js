'use strict';

const fs = require('node:fs');
const { Engine, JournalStore } = require('./engine');
const { ReconcileError } = require('./errors');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i += 1; }
    } else args._.push(a);
  }
  return args;
}

function readJson(path) { return JSON.parse(fs.readFileSync(path, 'utf8')); }

function parseQuota(s) {
  const quota = {};
  if (!s) return quota;
  for (const pair of s.split(',')) {
    const [k, v] = pair.split('=');
    quota[k] = Number(v);
  }
  return quota;
}

function makeEngine(args) {
  const store = args['state-dir'] ? new JournalStore(args['state-dir']) : null;
  return new Engine({
    slots: args.slots ? Number(args.slots) : 2,
    merchantQuota: parseQuota(args.quota),
    store,
  });
}

const commands = {
  // Full pipeline: ingest -> optional seal -> reconcile -> schedule -> apply all.
  reconcile(args) {
    const engine = makeEngine(args);
    if (args.snapshot) engine.loadSnapshot(readJson(args.snapshot));
    if (args.ledger) engine.ingestLedger(readJson(args.ledger));
    for (const s of (args.seal ? args.seal.split(',') : [])) {
      const [accountId, day] = s.split(':');
      engine.sealDay(accountId, day);
    }
    engine.reconcile({});
    engine.schedulePending();
    for (const task of [...engine.tasks.values()]) {
      if (task.status === 'running') engine.applyTask(task.taskId);
    }
    engine.persistState();
    return engine.report();
  },

  // Ingest late ledger entries against sealed days (SEALED / supersedes handling).
  ingest(args) {
    const engine = makeEngine(args);
    for (const s of (args.seal ? args.seal.split(',') : [])) {
      const [accountId, day] = s.split(':');
      engine.sealDay(accountId, day);
    }
    const accepted = engine.ingestLedger(readJson(args.ledger));
    return { accepted };
  },

  // Undo an applied repair in a recovered engine; prints restored snapshot bytes.
  undo(args) {
    const store = new JournalStore(args['state-dir']);
    const engine = Engine.recover({ store, slots: args.slots ? Number(args.slots) : 2 });
    const before = engine.undo(args.task);
    return { restored: true, task: args.task, snapshotBytes: before };
  },

  // Recover from journal and print report (replay must be idempotent).
  report(args) {
    const store = new JournalStore(args['state-dir']);
    const engine = Engine.recover({ store });
    return engine.report();
  },
};

const USAGE = 'usage: eod-reconcile <reconcile|ingest|undo|report> '
  + '[--ledger f] [--snapshot f] [--slots n] [--quota m=n,...] '
  + '[--seal acct:day,...] [--state-dir dir] [--task id]';

// Returns { code, output } so it can be tested in-process.
function run(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (!cmd || !commands[cmd]) return { code: 2, output: USAGE };
  try {
    const result = commands[cmd](args);
    return { code: 0, output: JSON.stringify(result, null, 2) };
  } catch (err) {
    const payload = err instanceof ReconcileError
      ? { error: err.code, message: err.message, details: err.details ?? null }
      : { error: 'INTERNAL', message: err.message };
    return { code: 1, output: JSON.stringify(payload, null, 2) };
  }
}

module.exports = { run };
