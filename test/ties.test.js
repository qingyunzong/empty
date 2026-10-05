'use strict';
// Acceptance 4: tied-optimal outcomes (equal score, unorderable by
// happens-before) are ALL listed in a stable sorted order.
const test = require('node:test');
const assert = require('node:assert');
const { judgeAccount, toEntries, CODE } = require('../src/judge');
const { bruteForceAccount } = require('../src/brute');
const { signaturesOf } = require('./helpers');

const CFG = { creditLimit: 100, dailyFreezeCap: 1000 };
const base = { account: 'A' };

function acceptedOpIds(outcome) {
  return outcome.verdicts.filter((v) => v.status === 'accepted').map((v) => v.opId);
}

test('concurrent equal-amount freezes competing for credit: all ties listed, stably sorted', () => {
  const records = [
    { ...base, opId: 'root', type: 'freeze', amount: 10, ts: 1, day: 0, deps: [] },
    { ...base, opId: 'A', type: 'freeze', amount: 60, ts: 2, day: 0, deps: ['root'] },
    { ...base, opId: 'B', type: 'freeze', amount: 60, ts: 3, day: 0, deps: ['root'] },
    { ...base, opId: 'C', type: 'freeze', amount: 60, ts: 4, day: 0, deps: ['root'] },
  ];
  const entries = toEntries(records);
  const r1 = judgeAccount(entries, CFG);
  const r2 = judgeAccount(entries, CFG);

  assert.strictEqual(r1.outcomes.length, 3, 'exactly one of A/B/C fits: three tied optima');
  const acceptedSets = r1.outcomes.map(acceptedOpIds);
  assert.deepStrictEqual(
    acceptedSets.map((s) => s.filter((id) => id !== 'root')).sort(),
    [['A'], ['B'], ['C']],
  );
  for (const o of r1.outcomes) {
    assert.strictEqual(o.available, 30, 'every tied outcome freezes 60+10');
    assert.deepStrictEqual(o.score, [70, 0, 2]);
  }
  const sigs = r1.outcomes.map((o) => o.signature);
  assert.deepStrictEqual(sigs, [...sigs].sort(), 'outcomes listed in stable sorted order');
  assert.deepStrictEqual(r1, r2, 'tie listing is deterministic across runs');

  const b = bruteForceAccount(entries, CFG);
  assert.deepStrictEqual(signaturesOf(r1.outcomes), signaturesOf(b.outcomes), 'agrees with brute force');
});

test('tied-optimal release sequences listed in stable sorted order', () => {
  const records = [
    { ...base, opId: 'F', type: 'freeze', amount: 50, ts: 1, day: 0, deps: [] },
    { ...base, opId: 'r1', type: 'release', freezeId: 'F', amount: 30, ts: 2, day: 0, deps: ['F'] },
    { ...base, opId: 'r2', type: 'release', freezeId: 'F', amount: 30, ts: 3, day: 0, deps: ['F'] },
  ];
  const entries = toEntries(records);
  const r = judgeAccount(entries, CFG);

  assert.strictEqual(r.outcomes.length, 2, 'only one of r1/r2 can be released: two tied optima');
  const acceptedSets = r.outcomes.map(acceptedOpIds).map((s) => s.filter((id) => id !== 'F'));
  assert.deepStrictEqual([...acceptedSets].sort(), [['r1'], ['r2']], 'both tied release sequences listed');
  const sigs = r.outcomes.map((o) => o.signature);
  assert.deepStrictEqual(sigs, [...sigs].sort(), 'release sequences in stable sorted order');
  assert.deepStrictEqual(judgeAccount(entries, CFG), r, 'tie listing is deterministic across runs');
  for (const o of r.outcomes) {
    assert.deepStrictEqual(o.score, [50, 30, 2]);
    assert.strictEqual(o.available, 80);
    const rejected = o.verdicts.find((v) => v.status === 'rejected');
    assert.strictEqual(rejected.code, CODE.RELEASE_EXCEEDS_FROZEN);
  }

  const b = bruteForceAccount(entries, CFG);
  assert.deepStrictEqual(signaturesOf(r.outcomes), signaturesOf(b.outcomes));
});

test('unequal competitors: only the strictly optimal outcome is listed', () => {
  const records = [
    { ...base, opId: 'root', type: 'freeze', amount: 10, ts: 1, day: 0, deps: [] },
    { ...base, opId: 'A', type: 'freeze', amount: 60, ts: 2, day: 0, deps: ['root'] },
    { ...base, opId: 'B', type: 'freeze', amount: 50, ts: 3, day: 0, deps: ['root'] },
  ];
  const r = judgeAccount(toEntries(records), CFG);
  assert.strictEqual(r.outcomes.length, 1);
  assert.deepStrictEqual(acceptedOpIds(r.outcomes[0]), ['root', 'A']);
});
