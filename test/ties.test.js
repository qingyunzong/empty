'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { judge, cmpSeq } = require('../src/judge');
const { bruteForceGroups } = require('../src/brute');
const { mulberry32, genAccountOps } = require('./helpers');

const CFG = { default: { limit: 500, dailyFreezeCap: 400 } };

test('tied-optimal concurrent equal releases are all listed, stably sorted', () => {
  const ops = [
    { opId: 'f1', account: 'A', type: 'freeze', amount: 100, day: 'd', ts: 1, causes: [] },
    { opId: 'r1', account: 'A', type: 'release', amount: 30, ref: 'f1', ts: 2, causes: ['f1'] },
    { opId: 'r2', account: 'A', type: 'release', amount: 30, ref: 'f1', ts: 3, causes: ['f1'] },
  ];
  const tied = judge(ops, CFG).accounts.A.tiedOptimal;
  assert.deepEqual(tied.sequences, [
    ['f1', 'r1', 'r2'],
    ['f1', 'r2', 'r1'],
  ]);
  // stable: sorted lexicographically and identical across runs
  const again = judge(ops, CFG).accounts.A.tiedOptimal;
  assert.deepEqual(again.sequences, tied.sequences);
  const sorted = tied.sequences.slice().sort(cmpSeq);
  assert.deepEqual(tied.sequences, sorted);
});

test('only verdict-equivalent orders are tied (r3 must come last)', () => {
  const ops = [
    { opId: 'f1', account: 'A', type: 'freeze', amount: 100, day: 'd', ts: 1, causes: [] },
    { opId: 'r1', account: 'A', type: 'release', amount: 30, ref: 'f1', ts: 2, causes: ['f1'] },
    { opId: 'r2', account: 'A', type: 'release', amount: 30, ref: 'f1', ts: 3, causes: ['f1'] },
    { opId: 'r3', account: 'A', type: 'release', amount: 50, ref: 'f1', ts: 4, causes: ['f1'] },
  ];
  const r = judge(ops, CFG).accounts.A;
  // canonical: r1,r2 accepted, r3 rejected (50 > 40 left). r3 stays rejected
  // only when it is released after both r1 and r2 -> exactly 2 tied optima.
  assert.deepEqual(r.tiedOptimal.sequences, [
    ['f1', 'r1', 'r2', 'r3'],
    ['f1', 'r2', 'r1', 'r3'],
  ]);
  const codes = new Map(r.verdicts.map((v) => [v.opId, v.code]));
  assert.equal(codes.get('r3'), 10);
});

test('judge matches brute-force linearization enumeration for n <= 8', () => {
  const rand = mulberry32(20261002);
  const cfg = { limit: 150, dailyFreezeCap: 120 };
  for (let iter = 0; iter < 150; iter++) {
    const n = 2 + Math.floor(rand() * 7); // 2..8 ops
    const ops = genAccountOps(rand, 'A', n, { maxAmount: 60 });
    const res = judge(ops, { default: cfg }, { maxTies: 100000 }).accounts.A;
    const brute = bruteForceGroups(ops, cfg);

    // canonical verdict vector selects the optimal group
    const canonicalCodes = new Map(res.verdicts.map((v) => [v.opId, v.code]));
    const key = brute.canonicalSeq.map((id) => canonicalCodes.get(id)).join(',');
    const group = brute.groups.get(key);
    assert.ok(group, `iter ${iter}: canonical group must exist in brute force`);

    // judge's tied optima == brute-force group with identical verdicts
    const bruteSeqs = group.sequences.slice().sort(cmpSeq);
    assert.deepEqual(
      res.tiedOptimal.sequences,
      bruteSeqs,
      `iter ${iter}: tied optima mismatch for ops ${JSON.stringify(ops.map((o) => [o.opId, o.type, o.amount, o.ref, o.causes]))}`
    );
    // judge sequence itself is one of the tied optima
    assert.ok(
      res.tiedOptimal.sequences.some((s) => s.join(',') === res.sequence.join(',')),
      `iter ${iter}: canonical sequence must be among tied optima`
    );
  }
});
