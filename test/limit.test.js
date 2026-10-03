import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, LimitError, MAX_OPS } from '../src/limit.js';

function accountOf(ledger, acc) {
  return ledger.state().accounts[acc];
}

test('A: partial captures aggregate, release frees the remainder', () => {
  const ledger = new Ledger();
  ledger.apply({ op: 'open', acc: 'a', creditLimit: 1000 });
  ledger.apply({ op: 'freeze', authId: 'au1', acc: 'a', amount: 500, ttl: 10000, time: 0 });
  assert.equal(accountOf(ledger, 'a').frozen, 500);
  assert.equal(accountOf(ledger, 'a').used, 0);

  ledger.apply({ op: 'capture', authId: 'au1', amount: 200, time: 10 });
  ledger.apply({ op: 'capture', authId: 'au1', amount: 200, time: 20 });
  let acc = accountOf(ledger, 'a');
  assert.equal(acc.frozen, 100);
  assert.equal(acc.used, 400);
  assert.equal(acc.available, 500);
  assert.equal(acc.auths.au1.status, 'open');
  assert.equal(acc.auths.au1.remaining, 100);

  ledger.apply({ op: 'release', authId: 'au1', time: 30 });
  acc = accountOf(ledger, 'a');
  assert.equal(acc.frozen, 0);
  assert.equal(acc.used, 400);
  assert.equal(acc.available, 600);
  assert.equal(acc.auths.au1.status, 'released');
  assert.equal(acc.auths.au1.remaining, 0);
});

test('A: capture up to the exact remainder closes the auth', () => {
  const ledger = new Ledger();
  ledger.apply({ op: 'open', acc: 'a', creditLimit: 300 });
  ledger.apply({ op: 'freeze', authId: 'au1', acc: 'a', amount: 120, ttl: 100, time: 0 });
  ledger.apply({ op: 'capture', authId: 'au1', amount: 70, time: 1 });
  ledger.apply({ op: 'capture', authId: 'au1', amount: 50, time: 2 });
  const acc = accountOf(ledger, 'a');
  assert.equal(acc.frozen, 0);
  assert.equal(acc.used, 120);
  assert.equal(acc.auths.au1.status, 'captured');
});

test('A: freeze cannot exceed available credit (E_LIMIT)', () => {
  const ledger = new Ledger();
  ledger.apply({ op: 'open', acc: 'a', creditLimit: 100 });
  ledger.apply({ op: 'freeze', authId: 'au1', acc: 'a', amount: 60, ttl: 100, time: 0 });
  assert.throws(
    () => ledger.apply({ op: 'freeze', authId: 'au2', acc: 'a', amount: 41, ttl: 100, time: 1 }),
    (err) => err instanceof LimitError && err.code === 'E_LIMIT',
  );
  ledger.apply({ op: 'freeze', authId: 'au2', acc: 'a', amount: 40, ttl: 100, time: 1 });
  assert.equal(accountOf(ledger, 'a').frozen, 100);
});

test('B: expiry boundary at exactly ttl (lazy, event time)', () => {
  const ledger = new Ledger();
  ledger.apply({ op: 'open', acc: 'a', creditLimit: 100 });
  ledger.apply({ op: 'freeze', authId: 'au1', acc: 'a', amount: 50, ttl: 500, time: 1000 });

  // One tick before expiry the auth is still capturable.
  ledger.apply({ op: 'capture', authId: 'au1', amount: 10, time: 1499 });
  assert.equal(accountOf(ledger, 'a').frozen, 40);

  // At exactly freeze.time + ttl the auth is expired: capture fails with
  // E_EXPIRED and the remaining 40 is auto-released.
  assert.throws(
    () => ledger.apply({ op: 'capture', authId: 'au1', amount: 10, time: 1500 }),
    (err) => err.code === 'E_EXPIRED',
  );
  const acc = accountOf(ledger, 'a');
  assert.equal(acc.frozen, 0);
  assert.equal(acc.used, 10);
  assert.equal(acc.auths.au1.status, 'expired');
});

test('B: sweep boundary matches lazy boundary exactly', () => {
  const ledger = new Ledger();
  ledger.apply({ op: 'open', acc: 'a', creditLimit: 100 });
  ledger.apply({ op: 'freeze', authId: 'au1', acc: 'a', amount: 50, ttl: 500, time: 1000 });
  ledger.apply({ op: 'sweep', time: 1499 });
  assert.equal(accountOf(ledger, 'a').frozen, 50);
  ledger.apply({ op: 'sweep', time: 1500 });
  const acc = accountOf(ledger, 'a');
  assert.equal(acc.frozen, 0);
  assert.equal(acc.auths.au1.status, 'expired');
});

test('B: extend pushes expiry out; expired auth cannot be extended', () => {
  const ledger = new Ledger();
  ledger.apply({ op: 'open', acc: 'a', creditLimit: 100 });
  ledger.apply({ op: 'freeze', authId: 'au1', acc: 'a', amount: 50, ttl: 100, time: 0 });
  ledger.apply({ op: 'extend', authId: 'au1', ttl: 100, time: 50 });
  ledger.apply({ op: 'capture', authId: 'au1', amount: 50, time: 199 });
  assert.equal(accountOf(ledger, 'a').used, 50);

  ledger.apply({ op: 'freeze', authId: 'au2', acc: 'a', amount: 10, ttl: 100, time: 0 });
  assert.throws(
    () => ledger.apply({ op: 'extend', authId: 'au2', ttl: 50, time: 100 }),
    (err) => err.code === 'E_EXPIRED',
  );
});

test('B: lazy expiry and periodic sweep converge to identical state', () => {
  const ops = [
    { op: 'open', acc: 'a', creditLimit: 500 },
    { op: 'freeze', authId: 'x', acc: 'a', amount: 100, ttl: 100, time: 0 },
    { op: 'freeze', authId: 'y', acc: 'a', amount: 100, ttl: 250, time: 0 },
    { op: 'capture', authId: 'x', amount: 30, time: 50 },
    { op: 'freeze', authId: 'z', acc: 'a', amount: 100, ttl: 1000, time: 120 },
    { op: 'capture', authId: 'y', amount: 40, time: 200 },
    { op: 'release', authId: 'z', time: 300 },
  ];
  const lazy = new Ledger();
  for (const op of ops) lazy.apply(op);

  const scanned = new Ledger();
  for (const op of ops) {
    scanned.apply({ op: 'sweep', time: op.time ?? 0 });
    scanned.apply(op);
  }
  scanned.apply({ op: 'sweep', time: 100000 });
  lazy.apply({ op: 'sweep', time: 100000 });
  assert.deepEqual(lazy.state(), scanned.state());
});

test('B: pending (never captured, not yet expired) auth is not a failure', () => {
  const ledger = new Ledger();
  ledger.apply({ op: 'open', acc: 'a', creditLimit: 100 });
  ledger.apply({ op: 'freeze', authId: 'au1', acc: 'a', amount: 50, ttl: 10000, time: 0 });
  const acc = accountOf(ledger, 'a');
  assert.equal(acc.auths.au1.status, 'open');
  assert.equal(acc.frozen, 50);
});

test('D: failed operations never change frozen/used', () => {
  const ledger = new Ledger();
  ledger.apply({ op: 'open', acc: 'a', creditLimit: 100 });
  ledger.apply({ op: 'freeze', authId: 'au1', acc: 'a', amount: 60, ttl: 100, time: 0 });
  const before = accountOf(ledger, 'a');
  const snapshot = { frozen: before.frozen, used: before.used };

  const failing = [
    { op: 'freeze', authId: 'au2', acc: 'a', amount: 41, ttl: 10, time: 1 }, // E_LIMIT
    { op: 'freeze', authId: 'au1', acc: 'a', amount: 1, ttl: 10, time: 1 }, // E_STATE dup
    { op: 'capture', authId: 'nope', amount: 1, time: 1 }, // E_STATE unknown
    { op: 'capture', authId: 'au1', amount: 61, time: 1 }, // E_LIMIT > remainder
    { op: 'capture', authId: 'au1', amount: -5, time: 1 }, // E_STATE bad amount
    { op: 'release', authId: 'nope', time: 1 }, // E_STATE unknown
    { op: 'extend', authId: 'nope', ttl: 5, time: 1 }, // E_STATE unknown
    { op: 'extend', authId: 'au1', ttl: 0, time: 1 }, // E_STATE bad ttl
  ];
  for (const op of failing) {
    assert.throws(() => ledger.apply(op), (err) => err instanceof LimitError);
    const after = accountOf(ledger, 'a');
    assert.equal(after.frozen, snapshot.frozen, JSON.stringify(op));
    assert.equal(after.used, snapshot.used, JSON.stringify(op));
  }
});

test('D: E_EXPIRED capture releases the remainder but adds nothing to used', () => {
  const ledger = new Ledger();
  ledger.apply({ op: 'open', acc: 'a', creditLimit: 100 });
  ledger.apply({ op: 'freeze', authId: 'au1', acc: 'a', amount: 60, ttl: 100, time: 0 });
  assert.throws(
    () => ledger.apply({ op: 'capture', authId: 'au1', amount: 10, time: 100 }),
    (err) => err.code === 'E_EXPIRED',
  );
  const acc = accountOf(ledger, 'a');
  assert.equal(acc.frozen, 0); // auto-released on expiry
  assert.equal(acc.used, 0); // failed capture captured nothing
});

test('state transitions on closed auths raise E_STATE', () => {
  const ledger = new Ledger();
  ledger.apply({ op: 'open', acc: 'a', creditLimit: 100 });
  ledger.apply({ op: 'freeze', authId: 'au1', acc: 'a', amount: 60, ttl: 100, time: 0 });
  ledger.apply({ op: 'release', authId: 'au1', time: 1 });
  assert.throws(() => ledger.apply({ op: 'capture', authId: 'au1', amount: 1, time: 2 }),
    (err) => err.code === 'E_STATE');
  assert.throws(() => ledger.apply({ op: 'release', authId: 'au1', time: 2 }),
    (err) => err.code === 'E_STATE');
  assert.throws(() => ledger.apply({ op: 'extend', authId: 'au1', ttl: 5, time: 2 }),
    (err) => err.code === 'E_STATE');
});

test('MAX_OPS is 20000', () => {
  assert.equal(MAX_OPS, 20000);
});

test('20000 operations execute sequentially', () => {
  const ledger = new Ledger();
  ledger.apply({ op: 'open', acc: 'a', creditLimit: 100000000 });
  for (let i = 0; i < MAX_OPS / 2; i++) {
    ledger.apply({ op: 'freeze', authId: 'au' + i, acc: 'a', amount: 1, ttl: 100000, time: i });
    ledger.apply({ op: 'capture', authId: 'au' + i, amount: 1, time: i });
  }
  const acc = accountOf(ledger, 'a');
  assert.equal(acc.used, MAX_OPS / 2);
  assert.equal(acc.frozen, 0);
});
