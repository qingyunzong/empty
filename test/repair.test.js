'use strict';
// Acceptance 2: after injecting repair, replaying the old history is unchanged
// and old ops' verdicts are preserved.
// Acceptance 3: a crash before writing compensations recovers to exactly-once.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readHistory, appendRecord } = require('../src/log');
const { judge } = require('../src/judge');
const cli = require('../cli.js');
const CONFIG = { acc1: { creditLimit: 1000, dailyFreezeCap: 1000 } };

const OPS = [
  { opId: 'f1', account: 'acc1', type: 'freeze', amount: 200, ts: 1, day: 0, deps: [] },
  { opId: 'f2', account: 'acc1', type: 'freeze', amount: 100, ts: 2, day: 0, deps: ['f1'] },
  { opId: 'r1', account: 'acc1', type: 'release', freezeId: 'f1', amount: 50, ts: 3, day: 0, deps: ['f2'] },
  { opId: 'h1', account: 'acc1', type: 'hold', freezeId: 'f2', amount: 40, ts: 4, day: 0, deps: ['r1'] },
];

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-'));
  const history = path.join(dir, 'history.ndjson');
  const config = path.join(dir, 'accounts.json');
  fs.writeFileSync(config, JSON.stringify(CONFIG));
  for (const op of OPS) appendRecord(history, op);
  return { dir, history, config };
}

// Runs the CLI in-process (the sandbox forbids spawning subprocesses),
// capturing stdout; returns { code, out }.
function runCli(args, env = {}) {
  let out = '';
  const code = cli.run(args, env, { out: (s) => (out += s), err: () => {}, stdin: null });
  return { code, out };
}

// Projects judged outcomes onto a subset of opIds: set of verdict signatures.
function projections(judgeResult, account, opIds) {
  const keep = new Set(opIds);
  return judgeResult.accounts[account].outcomes
    .map((o) => JSON.stringify(o.verdicts.filter((v) => keep.has(v.opId))))
    .sort();
}

test('acceptance 2: repair compensates without altering history replay', () => {
  const { dir, history, config } = setup();
  const before = judge(readHistory(history).records, CONFIG);
  assert.strictEqual(before.accounts.acc1.available, 750);

  const oldCopy = path.join(dir, 'old.ndjson');
  fs.copyFileSync(history, oldCopy);

  const report = JSON.parse(runCli(['repair', '--history', history, '--config', config, '--op', 'f1', '--op', 'r1', '--op', 'h1']).out);
  const actions = Object.fromEntries(report.map((r) => [r.op, r.action]));
  assert.deepStrictEqual(actions, { f1: 'compensate', r1: 'compensate', h1: 'compensate' });

  const { records: after1 } = readHistory(history);
  const comps = after1.filter((r) => r.compensates);
  assert.strictEqual(comps.length, 3);
  const cmpF1 = comps.find((c) => c.compensates === 'f1');
  assert.deepStrictEqual([cmpF1.type, cmpF1.freezeId, cmpF1.amount], ['release', 'f1', 150], 'freeze compensated by releasing the remainder');
  const cmpR1 = comps.find((c) => c.compensates === 'r1');
  assert.deepStrictEqual([cmpR1.type, cmpR1.amount], ['freeze', 50], 'release compensated by re-freezing');
  const cmpH1 = comps.find((c) => c.compensates === 'h1');
  assert.deepStrictEqual([cmpH1.type, cmpH1.amount], ['unhold', 40]);

  // Replaying the OLD history yields exactly the old result.
  const replay = judge(readHistory(oldCopy).records, CONFIG);
  assert.deepStrictEqual(replay, before);

  // Old ops' verdicts are unchanged in the repaired history; compensations apply.
  const after = judge(after1, CONFIG);
  const oldIds = OPS.map((o) => o.opId);
  assert.deepStrictEqual(projections(after, 'acc1', oldIds), projections(before, 'acc1', oldIds));
  for (const c of comps) {
    const v = after.accounts.acc1.outcomes[0].verdicts.find((x) => x.opId === c.opId);
    assert.strictEqual(v.status, 'accepted', `compensation ${c.opId} takes effect`);
  }
  assert.strictEqual(after.accounts.acc1.available, 850, 'credit restored by compensations');
});

test('acceptance 3: crash before writing compensations recovers to exactly-once', () => {
  const { history, config } = setup();
  const args = ['repair', '--history', history, '--config', config, '--op', 'f1', '--op', 'r1'];

  const crashed = runCli(args, { REPAIR_CRASH_BEFORE_WRITE: '1' });
  assert.strictEqual(crashed.code, 2);
  assert.strictEqual(readHistory(history).records.length, OPS.length, 'crash left no writes');

  runCli(args); // recovery run
  let comps = readHistory(history).records.filter((r) => r.compensates);
  assert.strictEqual(comps.length, 2, 'compensations written exactly once');
  assert.deepStrictEqual(comps.map((c) => c.compensates).sort(), ['f1', 'r1']);

  const report = JSON.parse(runCli(args).out); // idempotent re-run
  assert.ok(report.every((r) => r.action === 'skipped'));
  comps = readHistory(history).records.filter((r) => r.compensates);
  assert.strictEqual(comps.length, 2, 'no duplicate compensations after re-run');
});

test('acceptance 3: crash mid-write leaves a torn tail, recovery still exactly-once', () => {
  const { history, config } = setup();
  const args = ['repair', '--history', history, '--config', config, '--op', 'f1'];

  const crashed = runCli(args, { REPAIR_CRASH_MID_WRITE: '1' });
  assert.strictEqual(crashed.code, 2);

  const raw = fs.readFileSync(history, 'utf8');
  assert.ok(!raw.endsWith('\n'), 'torn tail has no trailing newline');

  const { records, warnings } = readHistory(history);
  assert.strictEqual(records.length, OPS.length, 'corrupt fragment is not a valid record');
  assert.strictEqual(warnings.length, 1, 'corrupt tail reported as a warning');

  runCli(args); // recovery run isolates the fragment and appends once
  const final = readHistory(history);
  const comps = final.records.filter((r) => r.compensates);
  assert.strictEqual(comps.length, 1, 'exactly one compensation after recovery');
  assert.strictEqual(comps[0].compensates, 'f1');
  const judged = judge(final.records, CONFIG);
  const v = judged.accounts.acc1.outcomes[0].verdicts.find((x) => x.opId === comps[0].opId);
  assert.strictEqual(v.status, 'accepted');
});

test('repair of a rejected op is a no-op', () => {
  const { history, config } = setup();
  appendRecord(history, { opId: 'f-big', account: 'acc1', type: 'freeze', amount: 5000, ts: 5, day: 0, deps: ['h1'] });
  const report = JSON.parse(runCli(['repair', '--history', history, '--config', config, '--op', 'f-big']).out);
  assert.strictEqual(report[0].action, 'no-op');
  assert.strictEqual(readHistory(history).records.filter((r) => r.compensates).length, 0);
});
