'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Account, E_RANGE, E_LIMIT, E_DUP } = require('../lib/account');

test('debit fails on category limit while total limit is sufficient', () => {
  const a = new Account({ totalLimit: 1000, categoryLimits: { travel: 300 } });
  const s1 = a.apply({ ts: 1, id: 'd1', op: 'debit', amount: 200, scope: 'travel' });
  assert.equal(s1.ok, true);
  const s2 = a.apply({ ts: 2, id: 'd2', op: 'debit', amount: 150, scope: 'travel' });
  assert.equal(s2.ok, false);
  assert.equal(s2.reason, E_LIMIT);
  assert.match(s2.detail, /category limit "travel"/);
  // total limit had plenty of room: 1000 - 200 = 800 >= 150
  assert.equal(a.debitedTotal, 200);
  assert.equal(a.available(), 800);
  // a different scope without a category cap can still use the total limit
  const s3 = a.apply({ ts: 3, id: 'd3', op: 'debit', amount: 500, scope: 'other' });
  assert.equal(s3.ok, true);
});

test('debit blocked by explicit freeze reports E_RANGE (freeze priority over total)', () => {
  const a = new Account({ totalLimit: 1000, categoryLimits: {} });
  a.apply({ ts: 1, id: 'f1', op: 'freeze', start: 0, end: 950 });
  const s = a.apply({ ts: 2, id: 'd1', op: 'debit', amount: 100, scope: 'x' });
  assert.equal(s.ok, false);
  assert.equal(s.reason, E_RANGE);
  assert.match(s.detail, /explicit freeze/);
  assert.equal(a.debitedTotal, 0);
});

test('debit beyond total limit reports E_LIMIT', () => {
  const a = new Account({ totalLimit: 100, categoryLimits: {} });
  const s = a.apply({ ts: 1, id: 'd1', op: 'debit', amount: 101, scope: 'x' });
  assert.equal(s.ok, false);
  assert.equal(s.reason, E_LIMIT);
  assert.match(s.detail, /total limit/);
});

test('duplicate request id fails with E_DUP and has no side effects', () => {
  const a = new Account({ totalLimit: 100, categoryLimits: {} });
  const s1 = a.apply({ ts: 1, id: 'x', op: 'debit', amount: 10, scope: 's' });
  assert.equal(s1.ok, true);
  const s2 = a.apply({ ts: 2, id: 'x', op: 'debit', amount: 10, scope: 's' });
  assert.equal(s2.ok, false);
  assert.equal(s2.reason, E_DUP);
  assert.equal(a.debitedTotal, 10);
  assert.equal(a.steps.length, 2);
  assert.equal(a.audit.length, 2);
});

test('failed ops write audit entries with a hash chain', () => {
  const a = new Account({ totalLimit: 100, categoryLimits: {} });
  a.apply({ ts: 1, id: 'ok', op: 'debit', amount: 10, scope: 's' });
  a.apply({ ts: 2, id: 'bad', op: 'debit', amount: 1000, scope: 's' });
  assert.equal(a.audit.length, 2);
  assert.equal(a.audit[0].prevHash, '0'.repeat(64));
  assert.equal(a.audit[1].prevHash, a.audit[0].hash);
  assert.equal(a.audit[1].ok, false);
  assert.equal(a.audit[1].reason, E_LIMIT);
});
