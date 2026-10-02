'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { judge } = require('../src/judge');
const { repair, SimulatedCrash } = require('../src/repair');
const { readHistory, appendOp } = require('../src/history');

const CFG = { default: { limit: 100, dailyFreezeCap: 90 } };

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'repair-test-'));
}

function seedHistory(file) {
  const ops = [
    { opId: 'f1', account: 'A', type: 'freeze', amount: 80, day: '2026-10-02', ts: 1, causes: [] },
    { opId: 'r1', account: 'A', type: 'release', amount: 90, ref: 'f1', day: '2026-10-02', ts: 2, causes: ['f1'] }, // code 10
    { opId: 'f2', account: 'A', type: 'freeze', amount: 50, day: '2026-10-02', ts: 3, causes: [] }, // code 13 (80+50>90)
    { opId: 'b1', account: 'B', type: 'freeze', amount: -5, day: '2026-10-02', ts: 4, causes: [] }, // code 15
    { opId: 'f1', account: 'A', type: 'freeze', amount: 5, day: '2026-10-02', ts: 5, causes: [] }, // code 12 dup
  ];
  for (const op of ops) {
    // bypass duplicate protection to inject an erroneous committed history
    fs.appendFileSync(file, JSON.stringify(op) + '\n');
  }
  return ops;
}

function verdictSnapshot(result) {
  const snap = {};
  for (const [acc, res] of Object.entries(result.accounts)) {
    snap[acc] = {
      available: res.available,
      frozenTotal: res.frozenTotal,
      verdicts: res.verdicts.map((v) => [v.opId, v.code]),
    };
  }
  return snap;
}

test('repair appends compensations instead of rewriting history', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'history.ndjson');
  const original = seedHistory(file);
  const before = fs.readFileSync(file, 'utf8');

  const summary = repair(file, CFG, { now: 1000 });
  assert.equal(summary.added.length, 4); // r1(10), f2(13), b1(15), dup f1(12)
  assert.deepEqual(
    summary.added.map((c) => c.opId).sort(),
    ['cmp:dup:f1', 'cmp:f2', 'cmp:b1', 'cmp:r1'].sort()
  );
  // history was only appended to, never modified
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(after.startsWith(before), 'old history bytes are untouched');
  assert.equal(after.split('\n').filter(Boolean).length, original.length + 4);
});

test('replaying old history after repair injection yields unchanged results', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'history.ndjson');
  seedHistory(file);
  const oldOps = readHistory(file);
  const beforeRepair = verdictSnapshot(judge(oldOps, CFG));

  repair(file, CFG, { now: 1000 });

  // replay the OLD history: identical judgments
  const replayOld = verdictSnapshot(judge(oldOps, CFG));
  assert.deepEqual(replayOld, beforeRepair);

  // judge the repaired history: original ops keep identical verdicts/quota
  const afterRepair = judge(readHistory(file), CFG);
  for (const [acc, snap] of Object.entries(beforeRepair)) {
    assert.equal(afterRepair.accounts[acc].available, snap.available, `${acc} available unchanged`);
    assert.equal(afterRepair.accounts[acc].frozenTotal, snap.frozenTotal);
    const afterOriginal = afterRepair.accounts[acc].verdicts
      .filter((v) => v.type !== 'compensate')
      .map((v) => [v.opId, v.code]);
    const sortKey = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]);
    assert.deepEqual(
      afterOriginal.slice().sort(sortKey),
      snap.verdicts.slice().sort(sortKey),
      `${acc} original verdicts unchanged`
    );
  }
  // compensations themselves are accepted markers with no quota effect
  const cmps = afterRepair.accounts.A.verdicts.filter((v) => v.type === 'compensate');
  assert.ok(cmps.length > 0 && cmps.every((v) => v.code === 0));
});

test('crash before writing all compensations: recovery writes each exactly once', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'history.ndjson');
  seedHistory(file);

  // crash after the first compensation write
  assert.throws(() => repair(file, CFG, { now: 1000, crashAfterWrites: 1 }), SimulatedCrash);
  let ops = readHistory(file);
  assert.equal(ops.filter((o) => o.type === 'compensate').length, 1);

  // recover: remaining compensations are written
  const second = repair(file, CFG, { now: 2000 });
  assert.equal(second.added.length, 3);
  assert.equal(second.skipped.length, 1);

  // third run is a no-op: exactly-once overall
  const third = repair(file, CFG, { now: 3000 });
  assert.equal(third.added.length, 0);
  assert.equal(third.skipped.length, 4);

  ops = readHistory(file);
  const cmpIds = ops.filter((o) => o.type === 'compensate').map((o) => o.opId);
  assert.equal(cmpIds.length, 4);
  assert.equal(new Set(cmpIds).size, 4, 'each compensation appears exactly once');
});

test('appendOp rejects duplicate opId with code 12', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'history.ndjson');
  appendOp(file, { opId: 'x', account: 'A', type: 'freeze', amount: 10, day: 'd', ts: 1 });
  assert.throws(() => appendOp(file, { opId: 'x', account: 'A', type: 'freeze', amount: 5 }), /duplicate opId/);
  try {
    appendOp(file, { opId: 'x', account: 'A', type: 'freeze', amount: 5 });
  } catch (err) {
    assert.equal(err.code, 12);
  }
});
