'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Engine } = require('../lib/engine');

function tmpWal() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wal-')), 'wal.jsonl');
}

test('acceptance 1: duplicate capture with same idemKey applies once', () => {
  const e = new Engine({ limit: 1000 });
  e.apply({ idemKey: 'a1', type: 'auth', amount: 200, seq: 1, ts: 1 });
  const msg = { idemKey: 'c1', type: 'capture', ref: 'a1', amount: 200, seq: 2, ts: 2 };
  const r1 = e.apply(msg);
  const r2 = e.apply(msg);
  const r3 = e.apply(msg);
  assert.equal(r1.status, 'applied');
  assert.equal(r2.duplicate, true);
  assert.equal(r3.duplicate, true);
  assert.equal(e.capturedTotal, 200);
  assert.equal(e.available(), 800);
  assert.equal(e.ledger.filter((ev) => ev.type === 'capture').length, 1);
});

test('same idemKey with different payload is a conflict, state untouched', () => {
  const e = new Engine({ limit: 1000 });
  e.apply({ idemKey: 'a1', type: 'auth', amount: 200, seq: 1, ts: 1 });
  e.apply({ idemKey: 'c1', type: 'capture', ref: 'a1', amount: 200, seq: 2, ts: 2 });
  const r = e.apply({ idemKey: 'c1', type: 'capture', ref: 'a1', amount: 150, seq: 3, ts: 3 });
  assert.equal(r.status, 'rejected');
  assert.equal(r.reason, 'idem-key-conflict');
  assert.equal(e.capturedTotal, 200);
  assert.equal(e.available(), 800);
  const report = e.finalize();
  assert.equal(report.conflicted, true);
  assert.deepEqual(report.certificate.rejected, [{ idemKey: 'c1', reason: 'idem-key-conflict' }]);
});

test('acceptance 2: refund arriving before capture is buffered then applied', () => {
  const e = new Engine({ limit: 1000 });
  e.apply({ idemKey: 'a1', type: 'auth', amount: 100, seq: 1, ts: 1 });
  const rb = e.apply({ idemKey: 'r1', type: 'refund', ref: 'c1', amount: 30, seq: 3, ts: 3 });
  assert.equal(rb.status, 'buffered');
  assert.equal(e.capturedTotal, 0);
  e.apply({ idemKey: 'c1', type: 'capture', ref: 'a1', amount: 80, seq: 2, ts: 2 });
  assert.equal(e.capturedTotal, 50);
  assert.equal(e.available(), 950);
  assert.deepEqual(e.ledger.map((ev) => ev.type), ['auth', 'capture', 'refund']);
  // resend of the drained refund returns the final reply, no double effect
  const dup = e.apply({ idemKey: 'r1', type: 'refund', ref: 'c1', amount: 30, seq: 3, ts: 3 });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.status, 'applied');
  assert.equal(e.capturedTotal, 50);
});

test('acceptance 3: expired auth auto-voids and wins the race against a late capture', () => {
  const e = new Engine({ limit: 1000 });
  e.apply({ idemKey: 'a1', type: 'auth', amount: 300, seq: 1, ts: 100, ttl: 50 });
  assert.equal(e.available(), 700);
  const r = e.apply({ idemKey: 'c1', type: 'capture', ref: 'a1', amount: 300, seq: 2, ts: 200 });
  assert.equal(r.status, 'rejected');
  assert.equal(r.reason, 'auth-void');
  assert.equal(e.available(), 1000);
  assert.equal(e.held, 0);
  assert.deepEqual(e.ledger.map((ev) => ev.type), ['auth', 'auto_void']);
  const report = e.finalize();
  assert.equal(report.conflicted, true);
});

test('credit never goes negative', () => {
  const e = new Engine({ limit: 100 });
  const r1 = e.apply({ idemKey: 'a1', type: 'auth', amount: 150, seq: 1, ts: 1 });
  assert.equal(r1.reason, 'insufficient-credit');
  e.apply({ idemKey: 'a2', type: 'auth', amount: 90, seq: 2, ts: 2 });
  const r2 = e.apply({ idemKey: 'c1', type: 'capture', ref: 'a2', amount: 120, seq: 3, ts: 3 });
  assert.equal(r2.reason, 'capture-exceeds-auth');
  e.apply({ idemKey: 'c2', type: 'capture', ref: 'a2', amount: 90, seq: 4, ts: 4 });
  const r3 = e.apply({ idemKey: 'r1', type: 'refund', ref: 'c2', amount: 95, seq: 5, ts: 5 });
  assert.equal(r3.reason, 'refund-exceeds-capture');
  assert.equal(e.available(), 10);
  assert.ok(e.held >= 0 && e.capturedTotal >= 0 && e.available() >= 0);
});

test('reversal appends a compensating event and restores credit; capture is not deleted', () => {
  const e = new Engine({ limit: 1000 });
  e.apply({ idemKey: 'a1', type: 'auth', amount: 100, seq: 1, ts: 1 });
  e.apply({ idemKey: 'c1', type: 'capture', ref: 'a1', amount: 100, seq: 2, ts: 2 });
  assert.equal(e.available(), 900);
  const r = e.apply({ idemKey: 'x1', type: 'reversal', ref: 'c1', seq: 3, ts: 3 });
  assert.equal(r.status, 'applied');
  assert.equal(e.available(), 1000);
  assert.equal(e.capturedTotal, 0);
  const types = e.ledger.map((ev) => ev.type);
  assert.deepEqual(types, ['auth', 'capture', 'reversal']);
  const rev = e.ledger[2];
  assert.equal(rev.compensating, true);
  assert.equal(rev.amount, 100);
});

test('void releases the hold; void of a captured auth is rejected', () => {
  const e = new Engine({ limit: 1000 });
  e.apply({ idemKey: 'a1', type: 'auth', amount: 100, seq: 1, ts: 1 });
  e.apply({ idemKey: 'v1', type: 'void', ref: 'a1', seq: 2, ts: 2 });
  assert.equal(e.available(), 1000);
  e.apply({ idemKey: 'a2', type: 'auth', amount: 100, seq: 3, ts: 3 });
  e.apply({ idemKey: 'c1', type: 'capture', ref: 'a2', amount: 100, seq: 4, ts: 4 });
  const r = e.apply({ idemKey: 'v2', type: 'void', ref: 'a2', seq: 5, ts: 5 });
  assert.equal(r.reason, 'already-captured');
});

test('crash after WAL write, before reply: restart recovers and resend is not re-applied', () => {
  const wal = tmpWal();
  const msgs = [
    { idemKey: 'a1', type: 'auth', amount: 200, seq: 1, ts: 1 },
    { idemKey: 'c1', type: 'capture', ref: 'a1', amount: 120, seq: 2, ts: 2 },
    { idemKey: 'r1', type: 'refund', ref: 'c1', amount: 20, seq: 3, ts: 3 },
  ];
  // First process: crashes right after the 2nd WAL append, before replying.
  const crashed = new Engine({
    limit: 1000,
    walPath: wal,
    fresh: true,
    onAppend: (n) => { if (n === 2) throw new Error('simulated crash'); },
  });
  crashed.apply(msgs[0]);
  assert.throws(() => crashed.apply(msgs[1]), /simulated crash/);

  // Restart: recover from WAL, resend the un-acked message, continue.
  const recovered = new Engine({ limit: 1000, walPath: wal });
  const dup = recovered.apply(msgs[1]);
  assert.equal(dup.duplicate, true);
  assert.equal(recovered.capturedTotal, 120); // applied exactly once
  recovered.apply(msgs[2]);

  // Compare against a clean, crash-free run.
  const clean = new Engine({ limit: 1000 });
  for (const m of msgs) clean.apply(m);
  assert.equal(recovered.available(), clean.available());
  assert.deepEqual(recovered.ledger, clean.ledger);
});

test('crash recovery preserves out-of-order buffered messages', () => {
  const wal = tmpWal();
  const first = new Engine({ limit: 1000, walPath: wal, fresh: true });
  first.apply({ idemKey: 'a1', type: 'auth', amount: 100, seq: 1, ts: 1 });
  first.apply({ idemKey: 'r1', type: 'refund', ref: 'c1', amount: 30, seq: 3, ts: 3 });
  // "crash": abandon the process, recover from WAL only
  const recovered = new Engine({ limit: 1000, walPath: wal });
  recovered.apply({ idemKey: 'c1', type: 'capture', ref: 'a1', amount: 80, seq: 2, ts: 2 });
  assert.equal(recovered.capturedTotal, 50);
  assert.deepEqual(recovered.ledger.map((ev) => ev.type), ['auth', 'capture', 'refund']);
});

test('virtual clock is monotonic: earlier-ts message after later-ts still sees expiry', () => {
  const e = new Engine({ limit: 1000 });
  e.apply({ idemKey: 'a1', type: 'auth', amount: 50, seq: 1, ts: 100, ttl: 10 });
  e.apply({ idemKey: 'a2', type: 'auth', amount: 50, seq: 2, ts: 500 }); // advances clock, expires a1
  const r = e.apply({ idemKey: 'c1', type: 'capture', ref: 'a1', amount: 50, seq: 3, ts: 105 });
  assert.equal(r.reason, 'auth-void');
});
