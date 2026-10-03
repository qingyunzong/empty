'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  diffBooks,
  verifyCertificate,
  ReconError,
  MAX_EVENTS_PER_BOOK,
} = require('../index');

const ev = (id, account, amount, direction, currency, rel) => ({
  id, account, amount, direction, currency, rel,
});

const BALANCED_LEFT = [
  ev('e1', 'A1', 100, 'debit', 'USD', 'r1'),
  ev('e2', 'A2', 100, 'credit', 'USD', 'r1'),
  ev('e3', 'A1', 50, 'debit', 'EUR', 'r2'),
  ev('e4', 'A2', 50, 'credit', 'EUR', 'r2'),
];

test('A: identical balanced books -> balanced, verifiable accept certificate', () => {
  const res = diffBooks(BALANCED_LEFT, BALANCED_LEFT.map((e) => ({ ...e })), { k: 5 });
  assert.equal(res.balanced, true);
  assert.deepEqual(res.scripts, []);
  assert.equal(res.certificate.type, 'accept');
  assert.equal(verifyCertificate(BALANCED_LEFT, BALANCED_LEFT, res.certificate), true);
});

test('A: reordering allowed while per-account causality is preserved', () => {
  // Interleave relation groups but keep each account's chain order.
  const right = [
    BALANCED_LEFT[0], // e1 (A1)
    BALANCED_LEFT[2], // e3 (A1)
    BALANCED_LEFT[1], // e2 (A2)
    BALANCED_LEFT[3], // e4 (A2)
  ];
  const res = diffBooks(BALANCED_LEFT, right, { k: 5 });
  assert.equal(res.balanced, true);
});

test('A: reordering that breaks per-account causality is rejected', () => {
  const right = [
    BALANCED_LEFT[2], // e3 (A1) before e1 (A1)
    BALANCED_LEFT[0],
    BALANCED_LEFT[1],
    BALANCED_LEFT[3],
  ];
  const res = diffBooks(BALANCED_LEFT, right, { k: 5 });
  assert.equal(res.balanced, false);
  assert.equal(res.certificate.reason, 'account-order');
  assert.equal(verifyCertificate(BALANCED_LEFT, right, res.certificate), true);
});

test('B: one-sided extra entries -> removeExtra', () => {
  const right = [...BALANCED_LEFT, ev('e9', 'A1', 500, 'debit', 'USD', 'r9')];
  const res = diffBooks(BALANCED_LEFT, right, { k: 5 });
  assert.equal(res.balanced, false);
  assert.equal(res.scripts.length, 1);
  assert.equal(res.scripts[0].cost, 1);
  assert.deepEqual(res.scripts[0].ops, [{ op: 'removeExtra', book: 'right', id: 'e9' }]);
  assert.equal(res.certificate.reason, 'content-divergence');
  assert.equal(verifyCertificate(BALANCED_LEFT, right, res.certificate), true);
});

test('C: relation-id mismatch -> relink', () => {
  const left = [
    ev('e1', 'A1', 100, 'debit', 'USD', 'r1'),
    ev('e2', 'A2', 100, 'credit', 'USD', 'rX'),
  ];
  const right = [
    ev('e1', 'A1', 100, 'debit', 'USD', 'r1'),
    ev('e2', 'A2', 100, 'credit', 'USD', 'r1'),
  ];
  const res = diffBooks(left, right, { k: 5 });
  assert.equal(res.balanced, false);
  assert.equal(res.scripts.length, 1);
  assert.deepEqual(res.scripts[0].ops, [{ op: 'relink', book: 'left', id: 'e2', rel: 'r1' }]);
  assert.equal(verifyCertificate(left, right, res.certificate), true);
});

test('tied minimal scripts are all returned (addMissing vs removeExtra)', () => {
  const left = [ev('d1', 'A1', 100, 'debit', 'USD', 'r1')];
  const right = [ev('c1', 'A2', 100, 'credit', 'USD', 'r1')];
  const res = diffBooks(left, right, { k: 3 });
  assert.equal(res.balanced, false);
  assert.equal(res.scripts.length, 2);
  for (const script of res.scripts) assert.equal(script.cost, 2);
  const keys = res.scripts.map((s) => s.ops.map((o) => o.op).sort().join('+'));
  assert.deepEqual(keys.sort(), ['addMissing+addMissing', 'removeExtra+removeExtra']);
});

test('E: beyond K -> SEARCH_BOUND, certificate carries proven lower bound', () => {
  const extras = [];
  for (let i = 0; i < 6; i += 1) {
    extras.push(ev(`x${i}`, i % 2 === 0 ? 'A1' : 'A2', 10 * (i + 1), 'debit', 'USD', `rx${i}`));
  }
  const right = [...BALANCED_LEFT, ...extras];
  const res = diffBooks(BALANCED_LEFT, right, { k: 5 });
  assert.equal(res.balanced, false);
  assert.equal(res.scripts.length, 0);
  assert.equal(res.error.code, 'SEARCH_BOUND');
  assert.equal(res.certificate.type, 'search-bound');
  assert.equal(res.certificate.k, 5);
  assert.equal(res.certificate.provenLowerBound, 6);
  assert.equal(res.certificate.reject.type, 'reject');
  assert.equal(verifyCertificate(BALANCED_LEFT, right, res.certificate), true);
});

test('E: the same books pass with a larger bound (min cost = 6)', () => {
  const extras = [];
  for (let i = 0; i < 6; i += 1) {
    extras.push(ev(`x${i}`, i % 2 === 0 ? 'A1' : 'A2', 10 * (i + 1), 'debit', 'USD', `rx${i}`));
  }
  const right = [...BALANCED_LEFT, ...extras];
  const res = diffBooks(BALANCED_LEFT, right, { k: 6 });
  assert.equal(res.error, undefined);
  assert.equal(res.scripts.length, 1);
  assert.equal(res.scripts[0].cost, 6);
  assert.ok(res.scripts[0].ops.every((o) => o.op === 'removeExtra' && o.book === 'right'));
});

test('DUP_ID: duplicate event id in one book', () => {
  const left = [ev('e1', 'A1', 1, 'debit', 'USD', 'r1'), ev('e1', 'A2', 1, 'credit', 'USD', 'r1')];
  assert.throws(() => diffBooks(left, [], {}), (err) => err instanceof ReconError && err.code === 'DUP_ID');
});

test('CURRENCY_MIX: a relation group mixing currencies', () => {
  const left = [ev('e1', 'A1', 1, 'debit', 'USD', 'r1'), ev('e2', 'A2', 1, 'credit', 'EUR', 'r1')];
  assert.throws(() => diffBooks(left, [], {}), (err) => err instanceof ReconError && err.code === 'CURRENCY_MIX');
});

test('SIZE_LIMIT: more than 200 events per book', () => {
  const left = [];
  for (let i = 0; i < MAX_EVENTS_PER_BOOK + 1; i += 1) {
    left.push(ev(`e${i}`, 'A1', 1, 'debit', 'USD', `r${i}`));
  }
  assert.throws(() => diffBooks(left, [], {}), (err) => err.code === 'SIZE_LIMIT');
});

test('CERT_INVALID: tampered certificates are rejected', () => {
  const res = diffBooks(BALANCED_LEFT, BALANCED_LEFT, { k: 5 });
  const tampered = { ...res.certificate, witness: ['e3', 'e1', 'e2', 'e4'] };
  assert.throws(
    () => verifyCertificate(BALANCED_LEFT, BALANCED_LEFT, tampered),
    (err) => err.code === 'CERT_INVALID'
  );
  const right = [...BALANCED_LEFT, ev('e9', 'A1', 500, 'debit', 'USD', 'r9')];
  const rej = diffBooks(BALANCED_LEFT, right, { k: 5 });
  const fake = { ...rej.certificate, leftPrefix: ['e1'] };
  assert.throws(
    () => verifyCertificate(BALANCED_LEFT, right, fake),
    (err) => err.code === 'CERT_INVALID'
  );
});

test('scripts cap: truncation is signalled, never silent', () => {
  const left = [ev('d1', 'A1', 100, 'debit', 'USD', 'r1')];
  const right = [ev('c1', 'A2', 100, 'credit', 'USD', 'r1')];
  const res = diffBooks(left, right, { k: 2, maxScripts: 1 });
  assert.equal(res.scripts.length, 1);
  assert.equal(res.scriptsTruncated, true);
});
