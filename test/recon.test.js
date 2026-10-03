'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  CycleError,
  createState,
  loadBase,
  applyDeltas,
  rollback,
  serialize,
} = require('../recon');

const CLI = path.join(__dirname, '..', 'cli.js');

const BASE = [
  { level: 'day', target: '2024-01-01', amount: 1000 },
  { level: 'mch', target: '2024-01-01/M001', amount: 600 },
  { level: 'mch', target: '2024-01-01/M002', amount: 400 },
  { level: 'txn', target: '2024-01-01/M001/T001', amount: 250 },
  { level: 'txn', target: '2024-01-01/M001/T002', amount: 350 },
];

function baseAmount(target) {
  return BASE.find((b) => b.target === target).amount;
}

function latestAmount(state, level, target) {
  const entry = state.targets.get(`${level}:${target}`);
  return entry.versions[entry.versions.length - 1].amount;
}

function delta(scope, target, d, eventTime, seq) {
  return { scope, target, delta: d, eventTime, seq };
}

function buildWithDeltas(deltas) {
  const state = createState();
  loadBase(state, BASE);
  applyDeltas(state, deltas);
  return state;
}

test('A: three-level rollback restores the original snapshot', () => {
  const state = buildWithDeltas([
    delta('day', '2024-01-01', 100, '2024-01-02T00:00:00Z', 1),
    delta('mch', '2024-01-01/M001', -50, '2024-01-02T00:01:00Z', 1),
    delta('txn', '2024-01-01/M001/T001', 25, '2024-01-02T00:02:00Z', 1),
  ]);
  assert.equal(latestAmount(state, 'day', '2024-01-01'), 1100);
  assert.equal(latestAmount(state, 'mch', '2024-01-01/M001'), 550);
  assert.equal(latestAmount(state, 'txn', '2024-01-01/M001/T001'), 275);

  rollback(state, { level: 'day', target: '2024-01-01' });

  // rollback(day) cascades: every level below returns to its base amount.
  for (const b of BASE) {
    assert.equal(latestAmount(state, b.level, b.target), baseAmount(b.target), b.target);
  }
  const rolled = state.out.filter((r) => r.status === 'rolledback');
  // day itself + both mch + both txn descendants.
  assert.equal(rolled.length, 5);
});

test('rollback(txn) does not affect sibling transactions', () => {
  const state = buildWithDeltas([
    delta('txn', '2024-01-01/M001/T001', 25, '2024-01-02T00:00:00Z', 1),
    delta('txn', '2024-01-01/M001/T002', 70, '2024-01-02T00:00:00Z', 2),
  ]);
  rollback(state, { level: 'txn', target: '2024-01-01/M001/T001' });
  assert.equal(latestAmount(state, 'txn', '2024-01-01/M001/T001'), 250);
  assert.equal(latestAmount(state, 'txn', '2024-01-01/M001/T002'), 420);
  assert.equal(latestAmount(state, 'mch', '2024-01-01/M001'), 600);
});

test('B: delta against a locked snapshot goes to pending', () => {
  const state = createState();
  loadBase(state, [{ level: 'day', target: '2024-01-01', amount: 1000, locked: true }]);
  applyDeltas(state, [delta('day', '2024-01-01', 100, '2024-01-02T00:00:00Z', 1)]);
  const entry = state.targets.get('day:2024-01-01');
  assert.equal(entry.versions.length, 1, 'no new version on a locked snapshot');
  const pending = state.out.filter((r) => r.status === 'pending');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].target, '2024-01-01');
});

test('watermark keeps late deltas out of the current recompute', () => {
  const state = createState();
  loadBase(state, [{ level: 'day', target: '2024-01-01', amount: 1000, watermark: '2024-01-02T12:00:00Z' }]);
  applyDeltas(state, [
    delta('day', '2024-01-01', 100, '2024-01-02T12:00:00Z', 1), // admitted (<= watermark)
    delta('day', '2024-01-01', 500, '2024-01-02T12:00:01Z', 2), // late -> pending
  ]);
  assert.equal(latestAmount(state, 'day', '2024-01-01'), 1100);
  assert.equal(state.out.filter((r) => r.status === 'pending').length, 1);
});

test('C: tied deltas on the same target are all emitted and marked TIE', () => {
  const state = buildWithDeltas([
    delta('mch', '2024-01-01/M001', 10, '2024-01-02T00:00:00Z', 1),
    delta('mch', '2024-01-01/M001', 20, '2024-01-02T00:00:00Z', 1),
    delta('mch', '2024-01-01/M001', 40, '2024-01-02T00:00:00Z', 2),
  ]);
  const ties = state.out.filter((r) => r.status === 'TIE');
  assert.equal(ties.length, 2, 'both equal-key deltas are listed, none dropped');
  assert.deepEqual(ties.map((r) => r.amount), [610, 630]);
  assert.equal(state.out.filter((r) => r.status === 'applied').length, 1);
  assert.equal(latestAmount(state, 'mch', '2024-01-01/M001'), 670);
});

test('rollback to a missing version records NO_VERSION', () => {
  const state = buildWithDeltas([]);
  assert.equal(rollback(state, { level: 'day', target: '2024-01-01', version: 99 }), false);
  assert.equal(rollback(state, { level: 'day', target: '2024-01-99' }), false);
  const nov = state.out.filter((r) => r.status === 'NO_VERSION');
  assert.equal(nov.length, 2);
  assert.equal(nov[0].version, 99);
});

test('rollback to an explicit historical version', () => {
  const state = buildWithDeltas([
    delta('day', '2024-01-01', 100, '2024-01-02T00:00:00Z', 1),
    delta('day', '2024-01-01', 100, '2024-01-03T00:00:00Z', 1),
  ]);
  rollback(state, { level: 'day', target: '2024-01-01', version: 2 });
  assert.equal(latestAmount(state, 'day', '2024-01-01'), 1100);
});

test('D: enumerate scope combinations (<=80 deltas), rollback(day) always restores base', () => {
  const scopes = ['day', 'mch', 'txn'];
  const targetOf = { day: '2024-01-01', mch: '2024-01-01/M001', txn: '2024-01-01/M001/T001' };
  // Enumerate scope sequences (len 1..3) but stay within the <=80 delta budget:
  // len 1..2 exhaustively (21 deltas), then fill with len-3 combos up to 80.
  const combos = [];
  for (let len = 1; len <= 3; len++) {
    const build = (prefix) => {
      if (prefix.length === len) { combos.push(prefix); return; }
      for (const s of scopes) build([...prefix, s]);
    };
    build([]);
  }
  const withinBudget = [];
  let spent = 0;
  for (const combo of combos) {
    if (spent + combo.length > 80) continue;
    spent += combo.length;
    withinBudget.push(combo);
  }
  combos.length = 0;
  combos.push(...withinBudget);
  const totalDeltas = combos.reduce((n, c) => n + c.length, 0);
  assert.ok(combos.length <= 80, `combo count ${combos.length} <= 80`);
  assert.ok(totalDeltas <= 80, `delta count ${totalDeltas} <= 80`);

  for (const combo of combos) {
    const deltas = combo.map((scope, i) =>
      delta(scope, targetOf[scope], (i + 1) * 7, `2024-01-02T00:00:${String(i).padStart(2, '0')}Z`, i + 1));
    const state = buildWithDeltas(deltas);
    rollback(state, { level: 'day', target: '2024-01-01' });
    for (const b of BASE) {
      assert.equal(
        latestAmount(state, b.level, b.target),
        baseAmount(b.target),
        `combo [${combo.join(',')}] polluted ${b.target}`,
      );
    }
  }
});

test('cyclic parent chain in base snapshots raises CycleError', () => {
  const state = createState();
  assert.throws(
    () => loadBase(state, [
      { level: 'day', target: '2024-01-01', amount: 1, version: 1, parent: 2 },
      { level: 'day', target: '2024-01-01', amount: 2, version: 2, parent: 1 },
    ]),
    CycleError,
  );
});

test('CLI: end-to-end recon run writes versions.jsonl', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-'));
  const base = path.join(dir, 'c.jsonl');
  const deltas = path.join(dir, 'd.jsonl');
  const out = path.join(dir, 'versions.jsonl');
  fs.writeFileSync(base, BASE.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(deltas, JSON.stringify(delta('txn', '2024-01-01/M001/T001', 25, '2024-01-02T00:00:00Z', 1)) + '\n');

  const run = spawnSync(process.execPath, [CLI, 'recon', '--base', base, '--deltas', deltas, '--rollback', 'day:2024-01-01', '--out', out], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const rows = fs.readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter((r) => r.status === 'confirmed').length, BASE.length);
  assert.equal(rows.filter((r) => r.status === 'applied').length, 1);
  assert.equal(rows.filter((r) => r.status === 'rolledback').length, 5);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['amount', 'level', 'parent', 'status', 'target', 'version']);
  }
});

test('CLI: cyclic parent chain exits with code 6', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-'));
  const base = path.join(dir, 'c.jsonl');
  fs.writeFileSync(base, [
    JSON.stringify({ level: 'day', target: '2024-01-01', amount: 1, version: 1, parent: 2 }),
    JSON.stringify({ level: 'day', target: '2024-01-01', amount: 2, version: 2, parent: 1 }),
  ].join('\n') + '\n');
  const errFile = path.join(dir, 'stderr.txt');
  const errFd = fs.openSync(errFile, 'w');
  const run = spawnSync(process.execPath, [CLI, 'recon', '--base', base, '--out', path.join(dir, 'v.jsonl')], { stdio: ['ignore', 'ignore', errFd] });
  fs.closeSync(errFd);
  assert.equal(run.status, 6);
  assert.match(fs.readFileSync(errFile, 'utf8'), /cyclic parent chain/);
});

test('serialize emits one JSON object per line', () => {
  const state = buildWithDeltas([delta('day', '2024-01-01', 5, '2024-01-02T00:00:00Z', 1)]);
  const lines = serialize(state).trim().split('\n');
  assert.equal(lines.length, BASE.length + 1);
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
});
