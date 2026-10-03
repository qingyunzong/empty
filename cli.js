'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { decodeFrames, validateEvent } = require('./lib/frame');
const { Collector, EXIT } = require('./lib/collector');
const { Store } = require('./lib/store');
const { ExitError, FrameError } = require('./lib/errors');

// Crash injection for recovery testing: LEDGER_CRASH_AT=recv|log|balance|cert,
// LEDGER_CRASH_AFTER=N crashes on the Nth hit of the point (default 1).
const crashAt = process.env.LEDGER_CRASH_AT || null;
let crashBudget = Number(process.env.LEDGER_CRASH_AFTER || 1);
function crashpoint(name) {
  if (crashAt === name && --crashBudget === 0) process.exit(99);
}

function usage() {
  console.error('usage: node cli.js <frames.bin> [--state-dir DIR] [--fresh] [--gap-window N]');
  process.exit(64);
}

function buildCert(collector, period) {
  const prevBalances = period.id > 1 ? collector.periods[period.id - 2].balances : {};
  return {
    version: 1,
    period: period.id,
    prevRoot: period.prevRoot,
    merkleRoot: period.merkleRoot,
    prevBalances,
    balances: period.balances,
    eventCount: period.certEvents.length,
    events: period.certEvents,
  };
}

function printReport(collector, store) {
  const balances = Object.fromEntries([...collector.balances.entries()].sort());
  const pend = collector.pending();
  const lines = [];
  lines.push('Balances:');
  const names = Object.keys(balances);
  if (!names.length) lines.push('  (none)');
  for (const a of names) lines.push(`  ${a}  ${balances[a]}`);
  lines.push('Pending queue:');
  if (!pend.length) lines.push('  (empty)');
  for (const p of pend) lines.push(`  ${p.acct} seq=${p.branchSeq} event=${p.eventId} (${p.reason})`);
  lines.push('Certificates:');
  if (!collector.periods.length) lines.push('  (none)');
  for (const p of collector.periods) {
    lines.push(`  period ${p.id}: events=${p.events.length} merkleRoot=${p.merkleRoot}`);
    lines.push(`    verify: node verify.js ${store.certPath(p.id)}`);
  }
  lines.push(`Duplicates suppressed: ${collector.dupCount}`);
  const report = {
    balances,
    pending: pend,
    periods: collector.periods.map((p) => ({ id: p.id, merkleRoot: p.merkleRoot, events: p.events, balances: p.balances })),
    duplicates: collector.dupCount,
  };
  fs.writeFileSync(path.join(store.dir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(lines.join('\n'));
}

function main() {
  const args = process.argv.slice(2);
  let input = null;
  let stateDir = path.join(process.cwd(), 'state');
  let fresh = false;
  let gapWindow = 8;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--state-dir') stateDir = args[++i];
    else if (args[i] === '--fresh') fresh = true;
    else if (args[i] === '--gap-window') gapWindow = Number(args[++i]);
    else if (input === null) input = args[i];
    else usage();
  }
  if (!input || !Number.isInteger(gapWindow) || gapWindow < 1) usage();

  const store = new Store(stateDir);
  store.init({ fresh });
  const { snapshot, frames: walFrames } = store.load();
  const collector = snapshot ? Collector.fromJSON(snapshot) : new Collector({ gapWindow });
  let framesProcessed = snapshot ? snapshot.walFrames : 0;
  let recording = false;
  const saveSnapshot = () => store.saveSnapshot(collector.toJSON(framesProcessed));
  // Mid-frame snapshot: the current frame is already durable in the WAL and
  // its registration is part of the collector state, so it counts as covered.
  const saveSnapshotMidFrame = () => store.saveSnapshot(collector.toJSON(framesProcessed + 1));

  collector.hooks = {
    beforeApply() {
      if (recording) store.appendWal({ op: 'event' });
      crashpoint('log');
    },
    afterApply() {
      saveSnapshotMidFrame();
      crashpoint('balance');
    },
  };

  const publishCert = (period) => {
    const cert = buildCert(collector, period);
    if (recording) store.appendWal({ op: 'cert', period: period.id, merkleRoot: period.merkleRoot });
    crashpoint('cert');
    store.saveCert(period.id, cert);
  };

  const handleFrame = (obj) => {
    if (obj && obj.type === 'event') {
      validateEvent(obj);
      collector.register(obj);
    } else if (obj && obj.type === 'close') {
      const p = collector.close();
      if (p) publishCert(p);
    } else {
      throw new FrameError(`unknown frame type: ${obj && obj.type}`);
    }
  };

  // Recovery: replay WAL frames not covered by the snapshot. Idempotent by
  // construction (dedup by eventId, deterministic application).
  for (let i = framesProcessed; i < walFrames.length; i++) {
    handleFrame(walFrames[i]);
    framesProcessed = i + 1;
  }
  collector.drain(); // flush events left buffered by a mid-frame crash
  saveSnapshot();
  for (const p of collector.periods) {
    if (!store.hasCert(p.id)) publishCert(p); // crash landed before cert publish
  }

  recording = true;
  const buf = fs.readFileSync(input);
  const allFrames = decodeFrames(buf);
  // The input file models the received stream: frames already in the WAL are
  // skipped so that re-running after a crash is idempotent.
  const freshFrames = allFrames.slice(framesProcessed);
  if (freshFrames.length < allFrames.length) {
    console.error(`resuming: ${allFrames.length - freshFrames.length} frame(s) already in WAL, skipped`);
  }
  for (const { obj } of freshFrames) {
    store.appendWal({ op: 'frame', obj });
    crashpoint('recv');
    handleFrame(obj);
    framesProcessed++;
    saveSnapshot();
  }

  // End of day: close the final open period and publish its certificate.
  const final = collector.close();
  if (final) publishCert(final);
  saveSnapshot();
  printReport(collector, store);
  store.close();
}

try {
  main();
} catch (err) {
  if (err instanceof FrameError) {
    console.error(`frame error: ${err.message}`);
    process.exit(EXIT.FRAME);
  }
  if (err instanceof ExitError) {
    console.error(`error: ${err.message}`);
    process.exit(err.code);
  }
  throw err;
}
