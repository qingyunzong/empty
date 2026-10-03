'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Account, E_RANGE } = require('../lib/account');

function make() {
  return new Account({ totalLimit: 1000, categoryLimits: {} });
}

test('overlapping freezes merge into one interval', () => {
  const a = make();
  a.apply({ ts: 1, id: 'f1', op: 'freeze', start: 100, end: 300 });
  a.apply({ ts: 2, id: 'f2', op: 'freeze', start: 250, end: 400 });
  assert.deepEqual(a.frozen, [[100, 400]]);
  assert.equal(a.frozenTotal, 300);
  const s3 = a.apply({ ts: 3, id: 'f3', op: 'freeze', start: 400, end: 500 });
  assert.equal(s3.ok, true);
  assert.deepEqual(a.frozen, [[100, 500]]);
  const s4 = a.apply({ ts: 4, id: 'f4', op: 'freeze', start: 50, end: 120 });
  assert.equal(s4.ok, true);
  assert.deepEqual(a.frozen, [[50, 500]]);
  assert.equal(a.frozenTotal, 450);
});

test('disjoint freezes stay separate and sorted', () => {
  const a = make();
  a.apply({ ts: 1, id: 'f1', op: 'freeze', start: 500, end: 600 });
  a.apply({ ts: 2, id: 'f2', op: 'freeze', start: 100, end: 200 });
  a.apply({ ts: 3, id: 'f3', op: 'freeze', start: 300, end: 400 });
  assert.deepEqual(a.frozen, [[100, 200], [300, 400], [500, 600]]);
});

test('unfreeze cuts existing freeze, splitting it', () => {
  const a = make();
  a.apply({ ts: 1, id: 'f1', op: 'freeze', start: 100, end: 500 });
  const cut = a.apply({ ts: 2, id: 'u1', op: 'unfreeze', start: 200, end: 300 });
  assert.equal(cut.ok, true);
  assert.deepEqual(a.frozen, [[100, 200], [300, 500]]);
  assert.equal(a.frozenTotal, 300);
  const left = a.apply({ ts: 3, id: 'u2', op: 'unfreeze', start: 0, end: 150 });
  assert.equal(left.ok, true);
  assert.deepEqual(a.frozen, [[150, 200], [300, 500]]);
  const right = a.apply({ ts: 4, id: 'u3', op: 'unfreeze', start: 450, end: 1000 });
  assert.equal(right.ok, true);
  assert.deepEqual(a.frozen, [[150, 200], [300, 450]]);
  const all = a.apply({ ts: 5, id: 'u4', op: 'unfreeze', start: 100, end: 500 });
  assert.equal(all.ok, true);
  assert.deepEqual(a.frozen, []);
  assert.equal(a.frozenTotal, 0);
});

test('unfreeze of non-frozen range fails with E_RANGE and no side effects', () => {
  const a = make();
  a.apply({ ts: 1, id: 'f1', op: 'freeze', start: 100, end: 200 });
  const s = a.apply({ ts: 2, id: 'u1', op: 'unfreeze', start: 300, end: 400 });
  assert.equal(s.ok, false);
  assert.equal(s.reason, E_RANGE);
  assert.deepEqual(a.frozen, [[100, 200]]);
  assert.equal(a.frozenTotal, 100);
});

test('invalid freeze ranges fail with E_RANGE', () => {
  const a = make();
  for (const [i, [start, end]] of [[-1, 100], [0, 0], [200, 100], [900, 1200]].entries()) {
    const s = a.apply({ ts: i + 1, id: `bad${i}`, op: 'freeze', start, end });
    assert.equal(s.ok, false);
    assert.equal(s.reason, E_RANGE);
  }
  assert.deepEqual(a.frozen, []);
});
