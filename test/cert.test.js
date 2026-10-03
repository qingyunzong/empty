import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCertificate, verifyCertificate } from '../src/cert.js';

const rows = [
  { currency: 'EUR', counterparty: 'A', trade_date: '2026-10-01', net_amount: 5, fee_sum: null, avg_fee: null, trade_count: 1 },
  { currency: 'USD', counterparty: 'A', trade_date: '2026-10-01', net_amount: 10, fee_sum: 2, avg_fee: 2, trade_count: 2 },
  { currency: 'USD', counterparty: 'B', trade_date: '2026-10-02', net_amount: -3, fee_sum: 1, avg_fee: 0.5, trade_count: 2 },
];
const inputs = { accounts: 'a'.repeat(64), trades: 'b'.repeat(64), events: 'c'.repeat(64) };

test('certificate verifies and contains input digests', () => {
  const cert = buildCertificate(rows, inputs);
  assert.equal(cert.row_count, 3);
  assert.deepEqual(cert.inputs, inputs);
  assert.equal(cert.chain.length, 3);
  assert.equal(cert.root, cert.chain[2]);
  assert.equal(verifyCertificate(cert), true);
});

test('certificate is deterministic', () => {
  assert.deepEqual(buildCertificate(rows, inputs), buildCertificate(rows, inputs));
});

// Acceptance C: tampering with one row fails verification.
test('C: tampered row fails verification', () => {
  const cert = buildCertificate(rows, inputs);
  cert.rows[1].net_amount = 999;
  assert.throws(() => verifyCertificate(cert), { code: 'E_CERT_TAMPER' });
});

test('C: tampered chain/root/inputs-detected fields fail', () => {
  const c1 = buildCertificate(rows, inputs);
  c1.root = '0'.repeat(64);
  assert.throws(() => verifyCertificate(c1), { code: 'E_CERT_TAMPER' });

  const c2 = buildCertificate(rows, inputs);
  c2.chain[0] = 'f'.repeat(64);
  assert.throws(() => verifyCertificate(c2), { code: 'E_CERT_TAMPER' });

  const c3 = buildCertificate(rows, inputs);
  c3.rows.reverse(); // canonical order violated
  assert.throws(() => verifyCertificate(c3), { code: 'E_CERT_TAMPER' });

  const c4 = buildCertificate(rows, inputs);
  c4.row_count = 99;
  assert.throws(() => verifyCertificate(c4), { code: 'E_CERT_TAMPER' });
});

test('empty certificate verifies', () => {
  const cert = buildCertificate([], inputs);
  assert.equal(cert.root, cert.genesis);
  assert.equal(verifyCertificate(cert), true);
});
