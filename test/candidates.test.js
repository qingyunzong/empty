'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FactoringStore } = require('../src/store.js');

test('same-distance candidates sort by amount diff, then id', () => {
  const store = new FactoringStore({ creditLine: 1e9, slop: 2 });
  store.addInvoice({ id: 'q', creditor: 'c', faceValue: 1000, advanceRate: 0.5, memo: 'alpha beta gamma' });
  // All three share the adjacent pair (alpha,beta) -> same word distance 0.
  store.addInvoice({ id: 'c2', creditor: 'c', faceValue: 1300, advanceRate: 0.5, memo: 'alpha beta' });
  store.addInvoice({ id: 'c1', creditor: 'c', faceValue: 1300, advanceRate: 0.5, memo: 'alpha beta' });
  store.addInvoice({ id: 'c0', creditor: 'c', faceValue: 1100, advanceRate: 0.5, memo: 'alpha beta' });

  const ranked = store.rankCandidates('q');
  assert.deepEqual(ranked.map((r) => r.id), ['c0', 'c1', 'c2']);
  assert.ok(ranked.every((r) => r.wordDistance === 0));
  assert.equal(ranked[0].amountDiff, 100);
});

test('smaller word distance ranks before amount diff', () => {
  const store = new FactoringStore({ creditLine: 1e9, slop: 2 });
  store.addInvoice({ id: 'q', creditor: 'c', faceValue: 1000, advanceRate: 0.5, memo: 'alpha x beta' });
  // 'near' shares (alpha,beta) at gap 1 in q's memo; 'far' shares only at gap... build a closer one:
  store.addInvoice({ id: 'gap1', creditor: 'c', faceValue: 9999, advanceRate: 0.5, memo: 'alpha x beta' });
  store.addInvoice({ id: 'gap0', creditor: 'c', faceValue: 1001, advanceRate: 0.5, memo: 'alpha beta' });
  const ranked = store.rankCandidates('q');
  // q's own windows: (alpha,beta) gap 1, (alpha,x) gap 0, (x,beta) gap 0.
  // gap0 shares (alpha,beta) -> distance 1 in q's memo; gap1 shares (alpha,x),(x,beta),(alpha,beta) -> distance 0.
  assert.deepEqual(ranked.map((r) => r.id), ['gap1', 'gap0']);
  assert.equal(ranked[0].wordDistance, 0);
  assert.equal(ranked[1].wordDistance, 1);
});

test('candidates exclude other creditors and revoked invoices', () => {
  const store = new FactoringStore({ creditLine: 1e9, slop: 1 });
  store.addInvoice({ id: 'q', creditor: 'c', faceValue: 100, advanceRate: 0.5, memo: 'shared words' });
  store.addInvoice({ id: 'other-creditor', creditor: 'd', faceValue: 100, advanceRate: 0.5, memo: 'shared words' });
  store.addInvoice({ id: 'revoked', creditor: 'c', faceValue: 100, advanceRate: 0.5, memo: 'shared words' });
  store.revokeInvoice('revoked');
  assert.deepEqual(store.rankCandidates('q'), []);
});
