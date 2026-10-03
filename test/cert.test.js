'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCert, verifyCert, canonical } = require('../src/cert');

const ROWS = [
  { ccy: 'USD', counterparty: 'A', trade_date: '2026-10-01', net_amount: 60, fee_total: 5, trade_count: 2 },
  { ccy: 'EUR', counterparty: 'B', trade_date: '2026-10-01', net_amount: 7, fee_total: null, trade_count: 1 },
];
const INPUTS = { 'accounts.jsonl': 'aa', 'trades.jsonl': 'bb', 'events.jsonl': 'cc' };

test('canonical: key order does not matter', () => {
  assert.equal(canonical({ b: 1, a: { d: 2, c: 3 } }), canonical({ a: { c: 3, d: 2 }, b: 1 }));
});

test('cert verifies against the same rows in any order', () => {
  const cert = makeCert(ROWS, INPUTS);
  assert.equal(cert.row_count, 2);
  assert.equal(cert.chain.length, 2);
  assert.equal(verifyCert([...ROWS].reverse(), cert).ok, true);
});

// Acceptance C: tampering with a single row breaks verification.
test('C: tampered row fails verification', () => {
  const cert = makeCert(ROWS, INPUTS);
  const tampered = ROWS.map((r) => ({ ...r }));
  tampered[0].net_amount = 61;
  const res = verifyCert(tampered, cert);
  assert.equal(res.ok, false);
});

test('C: tampered input digest fails verification', () => {
  const cert = makeCert(ROWS, INPUTS);
  const res = verifyCert(ROWS, cert, { ...INPUTS, 'trades.jsonl': 'ff' });
  assert.equal(res.ok, false);
  assert.match(res.reason, /trades\.jsonl/);
});

test('C: removed row fails verification', () => {
  const cert = makeCert(ROWS, INPUTS);
  assert.equal(verifyCert([ROWS[0]], cert).ok, false);
});

test('cert over empty result set is well-defined', () => {
  const cert = makeCert([], INPUTS);
  assert.equal(cert.row_count, 0);
  assert.deepEqual(cert.chain, []);
  assert.equal(verifyCert([], cert).ok, true);
});
