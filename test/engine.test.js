'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Engine, StateConflict } = require('../lib/engine');
const { Wal } = require('../lib/wal');

const LIMIT = 1000;
const TTL = 1e9; // effectively no expiry unless a test sets it

function makeEngine(opts = {}) {
  return new Engine({ creditLimit: LIMIT, authTtlMs: TTL, ...opts });
}

test('acceptance 1: duplicate capture with same idemKey applies once', () => {
  const e = makeEngine();
  e.apply({ idemKey: 'a1', type: 'auth', amount: 100, seq: 1, ts: 1 });
  const cap = { idemKey: 'c1', type: 'capture', ref: 'a1', amount: 60, seq: 2, ts: 2 };
  const r1 = e.apply(cap);
  assert.equal(r1.status, 'ok');
  assert.equal(e.available, 940); // 1000 - 100 frozen + 40 released remainder
  const ledgerLen = e.ledger.length;

  const r2 = e.apply({ ...cap }); // retransmission, identical payload
  assert.equal(r2.duplicate, true);
  assert.equal(r2.available, 940);
  assert.equal(e.available, 940);
  assert.equal(e.ledger.length, ledgerLen); // no double effect
});

test('idemKey reuse with different payload conflicts', () => {
  const e = makeEngine();
  e.apply({ idemKey: 'a1', type: 'auth', amount: 100, seq: 1, ts: 1 });
  e.apply({ idemKey: 'c1', type: 'capture', ref: 'a1', amount: 60, seq: 2, ts: 2 });
  assert.throws(
    () => e.apply({ idemKey: 'c1', type: 'capture', ref: 'a1', amount: 61, seq: 2, ts: 2 }),
    StateConflict
  );
});

test('acceptance 2: refund arriving before capture is buffered, then applied', () => {
  const e = makeEngine();
  const r0 = e.apply({ idemKey: 'r1', type: 'refund', ref: 'c1', amount: 30, seq: 3, ts: 3 });
  assert.equal(r0.status, 'buffered');
  assert.equal(e.available, LIMIT);

  e.apply({ idemKey: 'a1', type: 'auth', amount: 100, seq: 1, ts: 1 });
  const rc = e.apply({ idemKey: 'c1', type: 'capture', ref: 'a1', amount: 50, seq: 2, ts: 2 });
  assert.equal(rc.status, 'ok');
  // capture 50 of 100 hold releases 50, then buffered refund 30 lands
  assert.equal(e.available, 1000 - 50 + 30);
  assert.deepEqual(e.ledger.map((ev) => ev.type), ['auth', 'capture', 'refund']);

  // retransmitted refund stays idempotent even after flush
  const again = e.apply({ idemKey: 'r1', type: 'refund', ref: 'c1', amount: 30, seq: 3, ts: 3 });
  assert.equal(again.duplicate, true);
  assert.equal(e.available, 1000 - 50 + 30);
});

test('acceptance 3: expired auth auto-voids and loses the race with a late capture', () => {
  const e = new Engine({ creditLimit: LIMIT, authTtlMs: 1000 });
  e.apply({ idemKey: 'a1', type: 'auth', amount: 200, seq: 1, ts: 0 });
  assert.equal(e.available, 800);

  e.apply({ type: 'tick', ts: 1500 }); // virtual clock passes the expiry
  assert.equal(e.available, 1000); // hold released by auto-void
  assert.deepEqual(e.ledger.map((ev) => ev.type), ['auth', 'auto-void']);

  // late capture (even with an early ts) loses: the auth is already expired
  assert.throws(
    () => e.apply({ idemKey: 'c1', type: 'capture', ref: 'a1', amount: 200, seq: 2, ts: 500 }),
    (err) => err instanceof StateConflict && /expired/.test(err.message)
  );
  assert.equal(e.available, 1000);
});

test('capture wins if it arrives before the clock passes expiry', () => {
  const e = new Engine({ creditLimit: LIMIT, authTtlMs: 1000 });
  e.apply({ idemKey: 'a1', type: 'auth', amount: 200, seq: 1, ts: 0 });
  const r = e.apply({ idemKey: 'c1', type: 'capture', ref: 'a1', amount: 200, seq: 2, ts: 900 });
  assert.equal(r.status, 'ok');
  assert.equal(e.available, 800);
  e.apply({ type: 'tick', ts: 5000 }); // no auto-void: auth already captured
  assert.equal(e.available, 800);
});

test('reversal appends a compensating event and restores committed capture', () => {
  const e = makeEngine();
  e.apply({ idemKey: 'a1', type: 'auth', amount: 100, seq: 1, ts: 1 });
  e.apply({ idemKey: 'c1', type: 'capture', ref: 'a1', amount: 60, seq: 2, ts: 2 });
  e.apply({ idemKey: 'r1', type: 'refund', ref: 'c1', amount: 20, seq: 3, ts: 3 });
  assert.equal(e.available, 1000 - 60 + 20);

  e.apply({ idemKey: 'v1', type: 'reversal', ref: 'c1', seq: 4, ts: 4 });
  assert.equal(e.available, 1000); // remaining 40 restored
  const types = e.ledger.map((ev) => ev.type);
  assert.deepEqual(types, ['auth', 'capture', 'refund', 'reversal']); // nothing deleted

  assert.throws(
    () => e.apply({ idemKey: 'v2', type: 'reversal', ref: 'c1', seq: 5, ts: 5 }),
    StateConflict
  );
});

test('available credit never goes negative', () => {
  const e = makeEngine();
  assert.throws(
    () => e.apply({ idemKey: 'a1', type: 'auth', amount: 1001, seq: 1, ts: 1 }),
    StateConflict
  );
  assert.equal(e.available, LIMIT);
  e.apply({ idemKey: 'a2', type: 'auth', amount: 1000, seq: 2, ts: 2 });
  assert.equal(e.available, 0);
  assert.throws(
    () => e.apply({ idemKey: 'a3', type: 'auth', amount: 1, seq: 3, ts: 3 }),
    StateConflict
  );
});

test('refund exceeding the captured amount conflicts', () => {
  const e = makeEngine();
  e.apply({ idemKey: 'a1', type: 'auth', amount: 100, seq: 1, ts: 1 });
  e.apply({ idemKey: 'c1', type: 'capture', ref: 'a1', amount: 60, seq: 2, ts: 2 });
  assert.throws(
    () => e.apply({ idemKey: 'r1', type: 'refund', ref: 'c1', amount: 61, seq: 3, ts: 3 }),
    StateConflict
  );
});

test('crash after WAL write: restart recovers and re-sent reply does not re-apply', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-'));
  const walPath = path.join(dir, 'wal.log');

  let e = new Engine({ creditLimit: LIMIT, authTtlMs: TTL, wal: new Wal(walPath) });
  e.apply({ idemKey: 'a1', type: 'auth', amount: 100, seq: 1, ts: 1 });
  e.apply({ idemKey: 'c1', type: 'capture', ref: 'a1', amount: 60, seq: 2, ts: 2 });
  // crash: process dies after the WAL write, before the reply is delivered

  e = new Engine({ creditLimit: LIMIT, authTtlMs: TTL, wal: new Wal(walPath) });
  assert.equal(e.available, 940); // state recovered from WAL
  assert.deepEqual(e.ledger.map((ev) => ev.type), ['auth', 'capture']);

  // client retransmits the capture; stored reply is returned, no double effect
  const r = e.apply({ idemKey: 'c1', type: 'capture', ref: 'a1', amount: 60, seq: 2, ts: 2 });
  assert.equal(r.duplicate, true);
  assert.equal(e.available, 940);
  assert.equal(e.ledger.length, 2);

  // new work continues to append after recovery
  e.apply({ idemKey: 'r1', type: 'refund', ref: 'c1', amount: 10, seq: 3, ts: 3 });
  const e3 = new Engine({ creditLimit: LIMIT, authTtlMs: TTL, wal: new Wal(walPath) });
  assert.equal(e3.available, 950);
});

test('buffered out-of-order op survives crash and flushes after recovery', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-'));
  const walPath = path.join(dir, 'wal.log');

  let e = new Engine({ creditLimit: LIMIT, authTtlMs: TTL, wal: new Wal(walPath) });
  const r0 = e.apply({ idemKey: 'r1', type: 'refund', ref: 'c1', amount: 30, seq: 3, ts: 3 });
  assert.equal(r0.status, 'buffered');
  // crash while the refund is still buffered

  e = new Engine({ creditLimit: LIMIT, authTtlMs: TTL, wal: new Wal(walPath) });
  e.apply({ idemKey: 'a1', type: 'auth', amount: 100, seq: 1, ts: 1 });
  e.apply({ idemKey: 'c1', type: 'capture', ref: 'a1', amount: 50, seq: 2, ts: 2 });
  assert.equal(e.available, 1000 - 50 + 30); // buffered refund flushed after restart
});
