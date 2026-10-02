import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, E_LIMIT, E_STATE, E_EXPIRED } from '../src/limit.js';

function openLedger(limit = 1000) {
  const ledger = new Ledger();
  ledger.open('alice', limit);
  return ledger;
}

test('A: partial captures then release aggregate correctly', () => {
  const ledger = openLedger(1000);
  ledger.freeze('a1', 'alice', 100, 1000, 0);
  assert.equal(ledger.account('alice').frozen, 100);

  ledger.capture('a1', 30, 10);
  ledger.capture('a1', 20, 20);
  assert.deepEqual(ledger.account('alice'), { creditLimit: 1000, frozen: 50, used: 50 });

  ledger.release('a1', 30);
  assert.deepEqual(ledger.account('alice'), { creditLimit: 1000, frozen: 0, used: 50 });
  assert.equal(ledger.auths.get('a1').state, 'released');
});

test('A: capture of full remaining amount closes the auth', () => {
  const ledger = openLedger(1000);
  ledger.freeze('a1', 'alice', 100, 1000, 0);
  ledger.capture('a1', 40, 1);
  ledger.capture('a1', 60, 2);
  assert.equal(ledger.auths.get('a1').state, 'captured');
  assert.deepEqual(ledger.account('alice'), { creditLimit: 1000, frozen: 0, used: 100 });
});

test('A: capture beyond remaining frozen is E_LIMIT', () => {
  const ledger = openLedger(1000);
  ledger.freeze('a1', 'alice', 100, 1000, 0);
  ledger.capture('a1', 70, 1);
  assert.throws(() => ledger.capture('a1', 31, 2), { code: E_LIMIT });
  ledger.capture('a1', 30, 2);
  assert.equal(ledger.account('alice').used, 100);
});

test('freeze cannot exceed available credit (limit - frozen - used)', () => {
  const ledger = openLedger(100);
  ledger.freeze('a1', 'alice', 60, 100, 0);
  ledger.capture('a1', 20, 1);
  assert.throws(() => ledger.freeze('a2', 'alice', 41, 100, 2), { code: E_LIMIT });
  ledger.freeze('a2', 'alice', 40, 100, 2);
  assert.equal(ledger.account('alice').frozen, 80);
});

test('B: expiry boundary is exactly ttl (valid for t < t0+ttl, expired at t0+ttl)', () => {
  const ledger = openLedger(1000);
  ledger.freeze('a1', 'alice', 100, 1000, 0);
  ledger.capture('a1', 10, 99);
  assert.equal(ledger.account('alice').used, 10);

  ledger.freeze('a2', 'alice', 50, 100, 0);
  assert.throws(() => ledger.capture('a2', 1, 100), { code: E_EXPIRED });
  assert.equal(ledger.auths.get('a2').state, 'expired');
  assert.equal(ledger.account('alice').frozen, 90);
});

test('B: lazy expiry and periodic scan agree', () => {
  const lazy = openLedger(500);
  lazy.freeze('a1', 'alice', 100, 50, 0);
  lazy.freeze('a2', 'alice', 200, 150, 0);
  lazy.capture('a1', 40, 10);
  lazy.capture('a2', 10, 100);

  const scanned = openLedger(500);
  scanned.freeze('a1', 'alice', 100, 50, 0);
  scanned.freeze('a2', 'alice', 200, 150, 0);
  scanned.capture('a1', 40, 10);
  scanned.scan(100);
  scanned.capture('a2', 10, 100);

  assert.deepEqual(lazy.snapshot(), scanned.snapshot());
  assert.deepEqual(lazy.account('alice'), { creditLimit: 500, frozen: 190, used: 50 });
});

test('B: pending auth is not a failure; extend keeps it alive past original ttl', () => {
  const ledger = openLedger(1000);
  ledger.freeze('a1', 'alice', 100, 50, 0);
  ledger.extend('a1', 200, 40);
  ledger.capture('a1', 60, 100);
  assert.equal(ledger.account('alice').used, 60);
  assert.throws(() => ledger.capture('a1', 1, 240), { code: E_EXPIRED });
});

test('B: extend on expired auth is E_EXPIRED', () => {
  const ledger = openLedger(1000);
  ledger.freeze('a1', 'alice', 100, 10, 0);
  assert.throws(() => ledger.extend('a1', 100, 10), { code: E_EXPIRED });
});

test('D: failed operations do not change frozen/used', () => {
  const ledger = openLedger(100);
  ledger.freeze('a1', 'alice', 60, 1000, 0);
  const before = { ...ledger.account('alice') };

  assert.throws(() => ledger.freeze('a2', 'alice', 41, 100, 1), { code: E_LIMIT });
  assert.throws(() => ledger.capture('a1', 61, 1), { code: E_LIMIT });
  assert.throws(() => ledger.capture('nope', 1, 1), { code: E_STATE });
  assert.throws(() => ledger.release('nope', 1), { code: E_STATE });
  assert.throws(() => ledger.extend('nope', 10, 1), { code: E_STATE });
  assert.throws(() => ledger.freeze('a1', 'alice', 1, 100, 1), { code: E_STATE });

  assert.deepEqual(ledger.account('alice'), before);
});

test('D: failed capture after expiry only reflects the expiry itself', () => {
  const ledger = openLedger(100);
  ledger.freeze('a1', 'alice', 60, 10, 0);
  assert.throws(() => ledger.capture('a1', 5, 10), { code: E_EXPIRED });
  assert.deepEqual(ledger.account('alice'), { creditLimit: 100, frozen: 0, used: 0 });
  const frozenBefore = ledger.account('alice').frozen;
  assert.throws(() => ledger.release('a1', 20), { code: E_EXPIRED });
  assert.equal(ledger.account('alice').frozen, frozenBefore);
});
