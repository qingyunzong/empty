'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Account, E_LIMIT } = require('../lib/account');

test('same-timestamp debits: lexicographically smaller id wins, exactly one succeeds', () => {
  const a = new Account({ totalLimit: 100, categoryLimits: {} });
  // file order is "b" first; processing order must be id-sorted
  const report = a.applyAll([
    { ts: 7, id: 'b', op: 'debit', amount: 60, scope: 's' },
    { ts: 7, id: 'a', op: 'debit', amount: 60, scope: 's' },
  ]);
  assert.equal(report.steps[0].id, 'a');
  assert.equal(report.steps[0].ok, true);
  assert.equal(report.steps[1].id, 'b');
  assert.equal(report.steps[1].ok, false);
  assert.equal(report.steps[1].reason, E_LIMIT);
  assert.equal(report.final.debitedTotal, 60);
  assert.equal(report.final.available, 40);
});

test('ops are processed in (ts, id) order regardless of file order', () => {
  const a = new Account({ totalLimit: 100, categoryLimits: {} });
  const report = a.applyAll([
    { ts: 2, id: 'z', op: 'debit', amount: 30, scope: 's' },
    { ts: 1, id: 'y', op: 'debit', amount: 50, scope: 's' },
    { ts: 1, id: 'x', op: 'debit', amount: 40, scope: 's' },
  ]);
  assert.deepEqual(report.steps.map((s) => s.id), ['x', 'y', 'z']);
  assert.equal(report.steps[0].ok, true);  // x: 40 <= 100
  assert.equal(report.steps[1].ok, true);  // y: 50 <= 60
  assert.equal(report.steps[2].ok, false); // z: 30 > 10 left
  assert.equal(report.final.debitedTotal, 90);
});

test('same-timestamp duplicate ids: first in file order wins, second is E_DUP', () => {
  const a = new Account({ totalLimit: 100, categoryLimits: {} });
  const report = a.applyAll([
    { ts: 5, id: 'same', op: 'debit', amount: 10, scope: 's' },
    { ts: 5, id: 'same', op: 'debit', amount: 20, scope: 's' },
  ]);
  assert.equal(report.steps[0].ok, true);
  assert.equal(report.steps[1].ok, false);
  assert.equal(report.steps[1].reason, 'E_DUP');
  assert.equal(report.final.debitedTotal, 10);
});
