'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyPlan } = require('../lib/plan');

const E = (id, account, amount, extra = {}) => ({ id, account, amount, type: 'NORMAL', ...extra });

test('net protection: unbalanced fixAmounts rejected with E_PLAN_INVALID/22', () => {
  const entries = [E('a', 'A', 100), E('b', 'A', -50)];
  assert.throws(
    () => applyPlan(entries, { date: 'd', fixAmounts: { a: 200 } }),
    (e) => e.code === 'E_PLAN_INVALID' && e.exitCode === 22 && /net amount/.test(e.message)
  );
});

test('balanced fixAmounts accepted', () => {
  const entries = [E('a', 'A', 100), E('b', 'A', -100), E('c', 'B', 7)];
  const out = applyPlan(entries, { date: 'd', fixAmounts: { a: 60, b: -60 } });
  assert.equal(out.find((e) => e.id === 'a').amount, 60);
  assert.equal(out.find((e) => e.id === 'b').amount, -60);
});

test('net protection: unbalanced drop rejected', () => {
  const entries = [E('a', 'A', 100), E('b', 'A', -100)];
  assert.throws(
    () => applyPlan(entries, { date: 'd', dropIds: ['a'] }),
    (e) => e.code === 'E_PLAN_INVALID' && e.exitCode === 22
  );
  const out = applyPlan(entries, { date: 'd', dropIds: ['a', 'b'] });
  assert.deepEqual(out, []);
});

test('causality: reversal may not precede its original', () => {
  const entries = [
    E('o', 'A', 100),
    { id: 'r', account: 'A', amount: -100, type: 'REVERSAL', refId: 'o' },
  ];
  assert.throws(
    () => applyPlan(entries, { date: 'd', moveBefore: { r: 'o' } }),
    (e) => e.code === 'E_PLAN_INVALID' && e.exitCode === 22 && /precedes its original/.test(e.message)
  );
});

test('causality: dropping the original while keeping the reversal rejected', () => {
  const entries = [
    E('o', 'A', 100),
    { id: 'r', account: 'A', amount: -100, type: 'REVERSAL', refId: 'o' },
  ];
  assert.throws(
    () => applyPlan(entries, { date: 'd', dropIds: ['o'] }),
    (e) => e.code === 'E_PLAN_INVALID' && e.exitCode === 22
  );
  const out = applyPlan(entries, { date: 'd', dropIds: ['o', 'r'] });
  assert.deepEqual(out, []);
});

test('moveBefore reorders and unknown ids rejected', () => {
  const entries = [E('a', 'A', 1), E('b', 'A', 2), E('c', 'A', 3)];
  const out = applyPlan(entries, { date: 'd', moveBefore: { c: 'a' } });
  assert.deepEqual(out.map((e) => e.id), ['c', 'a', 'b']);
  assert.throws(() => applyPlan(entries, { date: 'd', dropIds: ['zz'] }), /unknown entry/);
  assert.throws(() => applyPlan(entries, { date: 'd', moveBefore: { a: 'zz' } }), /unknown anchor/);
  assert.throws(() => applyPlan(entries, { date: 'd', moveBefore: { a: 'a' } }), /before itself/);
});

test('sequential moves compose', () => {
  const entries = [E('a', 'A', 1), E('b', 'A', 2), E('c', 'A', 3), E('d', 'A', 4)];
  const out = applyPlan(entries, { date: 'd', moveBefore: [['d', 'a'], ['c', 'd']] });
  assert.deepEqual(out.map((e) => e.id), ['c', 'd', 'a', 'b']);
});
