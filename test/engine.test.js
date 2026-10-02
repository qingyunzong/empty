'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, ConflictError, NegativeFrozenError } = require('../src/engine');

function auth(report, id) {
  return report.auths[id];
}

test('acceptance 1: inc above limit is partially rejected', () => {
  const e = new Engine({ ttl: 1000 });
  e.ingest({ authId: 'A', type: 'hold', seq: 1, amount: 800, limit: 1000, ts: 0 });
  e.ingest({ authId: 'A', type: 'inc', seq: 2, amount: 500, ts: 1 });
  const r = e.report();
  assert.equal(auth(r, 'A').frozen, 1000);
  assert.equal(auth(r, 'A').available, 0);
  const cert = r.certificates.find((c) => c.transition === 'INC_PARTIAL');
  assert.ok(cert, 'expected INC_PARTIAL certificate');
  assert.equal(cert.requested, 500);
  assert.equal(cert.accepted, 200);
  assert.equal(cert.rejected, 300);
});

test('inc fully rejected when no room remains', () => {
  const e = new Engine({ ttl: 1000 });
  e.ingest({ authId: 'A', type: 'hold', seq: 1, amount: 1000, limit: 1000, ts: 0 });
  e.ingest({ authId: 'A', type: 'inc', seq: 2, amount: 10, ts: 1 });
  const cert = e.report().certificates.find((c) => c.transition === 'INC_PARTIAL');
  assert.equal(cert.accepted, 0);
  assert.equal(cert.rejected, 10);
  assert.equal(auth(e.report(), 'A').frozen, 1000);
});

test('acceptance 2: dec cannot push frozen below buffered complete candidate', () => {
  const e = new Engine({ ttl: 1000 });
  e.ingest({ authId: 'A', type: 'hold', seq: 1, amount: 1000, ts: 0 });
  e.ingest({ authId: 'A', type: 'complete', seq: 3, amount: 400, ts: 1 });
  assert.throws(
    () => e.ingest({ authId: 'A', type: 'dec', seq: 2, amount: 700, ts: 2 }),
    (err) => err instanceof NegativeFrozenError && err.exitCode === 4,
  );
});

test('acceptance 2b: dec that respects candidate wins the race, complete settles remainder', () => {
  const e = new Engine({ ttl: 1000 });
  e.ingest({ authId: 'A', type: 'hold', seq: 1, amount: 1000, ts: 0 });
  e.ingest({ authId: 'A', type: 'complete', seq: 3, amount: 400, ts: 2 });
  e.ingest({ authId: 'A', type: 'dec', seq: 2, amount: 500, ts: 1 });
  const r = e.report();
  assert.equal(auth(r, 'A').status, 'COMPLETED');
  assert.equal(auth(r, 'A').charged, 400);
  assert.equal(auth(r, 'A').frozen, 0);
  const complete = r.certificates.find((c) => c.transition === 'COMPLETE');
  assert.equal(complete.released, 100);
});

test('dec below zero is a negative-frozen error (exit 4)', () => {
  const e = new Engine({ ttl: 1000 });
  e.ingest({ authId: 'A', type: 'hold', seq: 1, amount: 100, ts: 0 });
  assert.throws(
    () => e.ingest({ authId: 'A', type: 'dec', seq: 2, amount: 101, ts: 1 }),
    NegativeFrozenError,
  );
});

test('acceptance 3: duplicate complete is idempotent', () => {
  const e = new Engine({ ttl: 1000 });
  const complete = { authId: 'A', type: 'complete', seq: 2, amount: 300, ts: 1 };
  e.ingest({ authId: 'A', type: 'hold', seq: 1, amount: 1000, ts: 0 });
  e.ingest(complete);
  e.ingest({ ...complete });
  const r = e.report();
  assert.equal(auth(r, 'A').charged, 300);
  assert.equal(r.certificates.filter((c) => c.transition === 'COMPLETE').length, 1);
  assert.equal(r.acks.filter((a) => a.result === 'duplicate').length, 1);
});

test('same seq with different payload is a conflict (exit 3)', () => {
  const e = new Engine({ ttl: 1000 });
  e.ingest({ authId: 'A', type: 'hold', seq: 1, amount: 1000, ts: 0 });
  e.ingest({ authId: 'A', type: 'inc', seq: 2, amount: 100, ts: 1 });
  assert.throws(
    () => e.ingest({ authId: 'A', type: 'inc', seq: 2, amount: 200, ts: 1 }),
    (err) => err instanceof ConflictError && err.exitCode === 3,
  );
});

test('conflicting buffered frame is a conflict (exit 3)', () => {
  const e = new Engine({ ttl: 1000 });
  e.ingest({ authId: 'A', type: 'hold', seq: 1, amount: 1000, ts: 0 });
  e.ingest({ authId: 'A', type: 'inc', seq: 5, amount: 100, ts: 1 });
  assert.throws(
    () => e.ingest({ authId: 'A', type: 'inc', seq: 5, amount: 999, ts: 1 }),
    ConflictError,
  );
});

test('acceptance 4: expiry auto-voids, late inc and late complete rejected with evidence', () => {
  const e = new Engine({ ttl: 100 });
  e.ingest({ authId: 'A', type: 'hold', seq: 1, amount: 500, ts: 0 });
  e.ingest({ authId: 'A', type: 'inc', seq: 2, amount: 100, ts: 150 });
  e.ingest({ authId: 'A', type: 'complete', seq: 3, amount: 200, ts: 160 });
  const r = e.report();
  assert.equal(auth(r, 'A').status, 'VOIDED');
  assert.equal(auth(r, 'A').frozen, 0);
  assert.equal(auth(r, 'A').charged, 0);
  assert.ok(r.certificates.some((c) => c.transition === 'AUTO_VOID' && c.released === 500));
  const reasons = r.ledger.filter((l) => l.kind === 'EVIDENCE').map((l) => l.reason);
  assert.ok(reasons.includes('LATE_INC'));
  assert.ok(reasons.includes('LATE_COMPLETE'));
});

test('out-of-order frames buffer and drain in seq order', () => {
  const e = new Engine({ ttl: 1000 });
  e.ingest({ authId: 'A', type: 'inc', seq: 3, amount: 100, ts: 2 });
  e.ingest({ authId: 'A', type: 'dec', seq: 2, amount: 50, ts: 1 });
  e.ingest({ authId: 'A', type: 'hold', seq: 1, amount: 1000, ts: 0 });
  const r = e.report();
  assert.equal(auth(r, 'A').frozen, 1050);
  assert.deepEqual(
    r.certificates.map((c) => c.transition),
    ['HOLD', 'DEC', 'INC'],
  );
});

test('complete transfers actual amount and releases the difference', () => {
  const e = new Engine({ ttl: 1000 });
  e.ingest({ authId: 'A', type: 'hold', seq: 1, amount: 1000, ts: 0 });
  e.ingest({ authId: 'A', type: 'complete', seq: 2, amount: 620, ts: 1 });
  const r = e.report();
  assert.equal(auth(r, 'A').charged, 620);
  assert.equal(auth(r, 'A').frozen, 0);
  assert.equal(r.certificates.find((c) => c.transition === 'COMPLETE').released, 380);
});

test('reverse only after complete and produces a reverse ledger entry', () => {
  const e = new Engine({ ttl: 1000 });
  e.ingest({ authId: 'A', type: 'hold', seq: 1, amount: 1000, ts: 0 });
  e.ingest({ authId: 'A', type: 'reverse', seq: 2, amount: 100, ts: 1 });
  e.ingest({ authId: 'A', type: 'complete', seq: 3, amount: 700, ts: 2 });
  e.ingest({ authId: 'A', type: 'reverse', seq: 4, amount: 200, ts: 3 });
  const r = e.report();
  assert.equal(auth(r, 'A').charged, 500);
  const reversals = r.ledger.filter((l) => l.kind === 'REVERSE');
  assert.equal(reversals.length, 1);
  assert.equal(reversals[0].amount, 200);
  assert.ok(r.ledger.some((l) => l.kind === 'EVIDENCE' && l.reason === 'REVERSE_NOT_COMPLETED'));
});

test('void releases everything and later frames are rejected', () => {
  const e = new Engine({ ttl: 1000 });
  e.ingest({ authId: 'A', type: 'hold', seq: 1, amount: 900, ts: 0 });
  e.ingest({ authId: 'A', type: 'void', seq: 2, amount: 0, ts: 1 });
  e.ingest({ authId: 'A', type: 'inc', seq: 3, amount: 10, ts: 2 });
  const r = e.report();
  assert.equal(auth(r, 'A').status, 'VOIDED');
  assert.equal(auth(r, 'A').frozen, 0);
  assert.equal(r.certificates.find((c) => c.transition === 'VOID').released, 900);
  assert.ok(r.ledger.some((l) => l.reason === 'LATE_INC'));
});

test('certificates form a hash chain', () => {
  const e = new Engine({ ttl: 1000 });
  e.ingest({ authId: 'A', type: 'hold', seq: 1, amount: 100, ts: 0 });
  e.ingest({ authId: 'A', type: 'complete', seq: 2, amount: 40, ts: 1 });
  const certs = e.report().certificates;
  assert.equal(certs.length, 2);
  assert.equal(certs[1].prevHash, certs[0].hash);
  assert.match(certs[0].hash, /^[0-9a-f]{64}$/);
});
