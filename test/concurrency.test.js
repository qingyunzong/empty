import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.js';

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}

function baseLedger() {
  const ledger = new Ledger();
  ledger.apply({ op: 'open_account', accountId: 'acct', creditLimit: 1000 });
  ledger.apply({ op: 'authorize', accountId: 'acct', authId: 'A1', amount: 300 });
  return ledger;
}

test('concurrent captures: total order by (seq, requestId) regardless of arrival permutation', () => {
  // Three concurrent captures, same arrival seq, 120 each against 300 frozen:
  // canonically ordered by requestId, the first two succeed, the third fails.
  const captures = [
    { op: 'capture', accountId: 'acct', authId: 'A1', amount: 120, merchantId: 'm1', seq: 7, requestId: 'req-c' },
    { op: 'capture', accountId: 'acct', authId: 'A1', amount: 120, merchantId: 'm1', seq: 7, requestId: 'req-a' },
    { op: 'capture', accountId: 'acct', authId: 'A1', amount: 120, merchantId: 'm1', seq: 7, requestId: 'req-b' },
  ];
  const perms = permutations(captures);
  assert.equal(perms.length, 6);
  let canonical = null;
  for (const perm of perms) {
    const ledger = baseLedger();
    let error = null;
    try {
      ledger.applyBatch(perm);
    } catch (e) {
      error = e;
    }
    assert.ok(error, 'expected the third capture to fail');
    assert.equal(error.code, 'EXCEEDS_HELD');
    // req-a and req-b (first two by requestId) always win, req-c always fails
    assert.match(error.message, /req-c|120 exceeds remaining frozen 60/);
    const snap = ledger.snapshot();
    delete snap.eventsApplied; // journal length may differ per permutation? no: same applied count
    if (!canonical) canonical = snap;
    assert.deepEqual(snap, canonical);
    assert.equal(ledger.held('acct'), 60);
    assert.equal(ledger.settled('m1'), 240);
  }
});

test('arrival seq dominates requestId in the total order', () => {
  const ledger = baseLedger();
  // Arrival order puts req-a first, but seq 1 (req-z) must settle first.
  assert.throws(
    () => ledger.applyBatch([
      { op: 'capture', accountId: 'acct', authId: 'A1', amount: 200, merchantId: 'm1', seq: 2, requestId: 'req-a' },
      { op: 'capture', accountId: 'acct', authId: 'A1', amount: 200, merchantId: 'm1', seq: 1, requestId: 'req-z' },
    ]),
    (e) => e.code === 'EXCEEDS_HELD',
  );
  // seq 1 (req-z) consumed 200, leaving 100; seq 2 (req-a) then failed.
  assert.equal(ledger.held('acct'), 100);
  assert.equal(ledger.settled('m1'), 200);
  const hold = ledger.accounts.get('acct').holds.get('A1');
  assert.deepEqual(hold.captures.map((c) => c.requestId), ['req-z']);
});

test('mixed batch keeps non-capture commands in arrival position', () => {
  const ledger = new Ledger();
  ledger.apply({ op: 'open_account', accountId: 'acct', creditLimit: 500 });
  ledger.applyBatch([
    { op: 'authorize', accountId: 'acct', authId: 'A1', amount: 300 },
    { op: 'capture', accountId: 'acct', authId: 'A1', amount: 100, merchantId: 'm1', seq: 1, requestId: 'r2' },
    { op: 'capture', accountId: 'acct', authId: 'A1', amount: 100, merchantId: 'm1', seq: 1, requestId: 'r1' },
    { op: 'release', accountId: 'acct', authId: 'A1', amount: 50 },
  ]);
  assert.equal(ledger.held('acct'), 50);
  assert.equal(ledger.available('acct'), 250);
  const hold = ledger.accounts.get('acct').holds.get('A1');
  assert.deepEqual(hold.captures.map((c) => c.requestId), ['r1', 'r2']);
});
