'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { judge } = require('../src/judge');

const CFG = { default: { limit: 200, dailyFreezeCap: 150 } };

function verdictsOf(result, account) {
  const m = new Map();
  for (const v of result.accounts[account].verdicts) m.set(v.opId, v.code);
  return m;
}

test('freeze occupies quota, release frees it (partial allowed)', () => {
  const ops = [
    { opId: 'f1', account: 'A', type: 'freeze', amount: 100, day: 'd', ts: 1, causes: [] },
    { opId: 'r1', account: 'A', type: 'release', amount: 30, ref: 'f1', ts: 2, causes: ['f1'] },
    { opId: 'r2', account: 'A', type: 'release', amount: 20, ref: 'f1', ts: 3, causes: ['f1'] },
  ];
  const r = judge(ops, CFG);
  assert.equal(r.accounts.A.available, 150); // 200 - (100 - 30 - 20)
  assert.equal(r.accounts.A.frozenTotal, 50);
  assert.deepEqual(r.accounts.A.sequence, ['f1', 'r1', 'r2']);
});

test('hold depends on an unreleased freeze and keeps quota occupied', () => {
  const ops = [
    { opId: 'f1', account: 'A', type: 'freeze', amount: 100, day: 'd', ts: 1, causes: [] },
    { opId: 'h1', account: 'A', type: 'hold', amount: 40, ref: 'f1', ts: 2, causes: ['f1'] },
    { opId: 'r1', account: 'A', type: 'release', amount: 100, ref: 'f1', ts: 3, causes: ['h1'] },
    { opId: 'h2', account: 'A', type: 'hold', amount: 10, ref: 'f1', ts: 4, causes: ['r1'] },
  ];
  const r = judge(ops, CFG);
  const v = verdictsOf(r, 'A');
  assert.equal(v.get('h1'), 0);
  assert.equal(v.get('r1'), 0); // releases held+remaining
  assert.equal(v.get('h2'), 14); // freeze fully released -> hold rejected
  assert.equal(r.accounts.A.available, 200);
});

test('release more than frozen -> code 10', () => {
  const ops = [
    { opId: 'f1', account: 'A', type: 'freeze', amount: 50, day: 'd', ts: 1, causes: [] },
    { opId: 'r1', account: 'A', type: 'release', amount: 51, ref: 'f1', ts: 2, causes: ['f1'] },
    { opId: 'r2', account: 'A', type: 'release', amount: 1, ref: 'nope', ts: 3, causes: [] },
  ];
  const v = verdictsOf(judge(ops, CFG), 'A');
  assert.equal(v.get('r1'), 10);
  assert.equal(v.get('r2'), 10); // releasing against nothing freezes
});

test('freeze driving available negative -> code 11', () => {
  const ops = [
    { opId: 'f1', account: 'A', type: 'freeze', amount: 120, day: 'd', ts: 1, causes: [] },
    { opId: 'f2', account: 'A', type: 'freeze', amount: 90, day: 'd', ts: 2, causes: [] },
  ];
  const r = judge(ops, { default: { limit: 200, dailyFreezeCap: 500 } });
  const v = verdictsOf(r, 'A');
  assert.equal(v.get('f1'), 0);
  assert.equal(v.get('f2'), 11);
  assert.equal(r.accounts.A.available, 80);
});

test('duplicate opId -> code 12, first occurrence wins', () => {
  const ops = [
    { opId: 'f1', account: 'A', type: 'freeze', amount: 10, day: 'd', ts: 1, causes: [] },
    { opId: 'f1', account: 'A', type: 'freeze', amount: 20, day: 'd', ts: 2, causes: [] },
  ];
  const r = judge(ops, CFG);
  const codes = r.accounts.A.verdicts.map((v) => v.code);
  assert.deepEqual(codes, [0, 12]);
  assert.equal(r.accounts.A.frozenTotal, 10); // only the first freeze applied
});

test('daily freeze cap: overflow rejected with code 13 and no partial effect', () => {
  const ops = [
    { opId: 'f1', account: 'A', type: 'freeze', amount: 80, day: 'd', ts: 1, causes: [] },
    { opId: 'f2', account: 'A', type: 'freeze', amount: 80, day: 'd', ts: 2, causes: [] }, // 80+80>150 -> 13
    { opId: 'f3', account: 'A', type: 'freeze', amount: 70, day: 'd', ts: 3, causes: [] }, // 80+70=150 fits
    { opId: 'f4', account: 'A', type: 'freeze', amount: 1, day: 'd+1', ts: 4, causes: [] }, // other day ok
  ];
  const r = judge(ops, CFG);
  const v = verdictsOf(r, 'A');
  assert.equal(v.get('f2'), 13);
  assert.equal(v.get('f3'), 0); // proves f2 had no partial effect on the budget
  assert.equal(v.get('f4'), 0);
  assert.equal(r.accounts.A.dailyFrozen['d'], 150);
  assert.equal(r.accounts.A.frozenTotal, 151);
});

test('happens-before merge: causal order is respected across branches', () => {
  // branch 1: f1 -> r1 ; branch 2: f2 (concurrent with branch 1)
  // r2 depends on both r1 and f2 (merge point)
  const ops = [
    { opId: 'f1', account: 'A', type: 'freeze', amount: 100, day: 'd', ts: 1, causes: [] },
    { opId: 'f2', account: 'A', type: 'freeze', amount: 50, day: 'd', ts: 2, causes: [] },
    { opId: 'r1', account: 'A', type: 'release', amount: 100, ref: 'f1', ts: 3, causes: ['f1'] },
    { opId: 'r2', account: 'A', type: 'release', amount: 40, ref: 'f2', ts: 4, causes: ['r1', 'f2'] },
  ];
  const r = judge(ops, CFG);
  const seq = r.accounts.A.sequence;
  assert.ok(seq.indexOf('f1') < seq.indexOf('r1'), 'cause before effect');
  assert.ok(seq.indexOf('r1') < seq.indexOf('r2'), 'merge respects both parents');
  assert.ok(seq.indexOf('f2') < seq.indexOf('r2'));
  assert.equal(r.accounts.A.available, 190); // 200 - (50-40) - (100-100)
});

test('causality cycle -> code 16, other ops unaffected', () => {
  const ops = [
    { opId: 'x', account: 'A', type: 'freeze', amount: 10, day: 'd', ts: 1, causes: ['y'] },
    { opId: 'y', account: 'A', type: 'freeze', amount: 10, day: 'd', ts: 2, causes: ['x'] },
    { opId: 'z', account: 'A', type: 'freeze', amount: 10, day: 'd', ts: 3, causes: [] },
  ];
  const r = judge(ops, CFG);
  const v = verdictsOf(r, 'A');
  assert.equal(v.get('x'), 16);
  assert.equal(v.get('y'), 16);
  assert.equal(v.get('z'), 0);
  assert.deepEqual(r.accounts.A.cyclic.sort(), ['x', 'y']);
});

test('invalid amount -> code 15', () => {
  const ops = [{ opId: 'b1', account: 'A', type: 'freeze', amount: -5, day: 'd', ts: 1, causes: [] }];
  assert.equal(verdictsOf(judge(ops, CFG), 'A').get('b1'), 15);
});
