import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, CrashError, E_INVARIANT } from '../src/ledger.js';
import { tempDir } from './helpers.js';

function openWith(balances, dir) {
  return new Ledger(dir, { initBalances: balances }).open();
}

test('reversal undoes exactly the committed effect', () => {
  const dir = tempDir();
  const l = openWith({ alice: 100 }, dir);
  l.submit({ key: 'k1', op: 'freeze', account: 'alice', amount: 50 });
  l.submit({ key: 'k2', op: 'debit', account: 'alice', amount: 30 });
  assert.deepEqual(l.balance('alice'), { account: 'alice', balance: 70, frozen: 20, available: 50 });

  // reversing the freeze now would drive frozen negative -> rejected, no effect
  assert.throws(() => l.submit({ key: 'k3', op: 'reverse', target: 'k1' }), (err) => err.code === E_INVARIANT);
  assert.equal(l.status('k3').status, 'aborted');
  assert.deepEqual(l.balance('alice'), { account: 'alice', balance: 70, frozen: 20, available: 50 });

  // reversing the debit restores balance and frozen exactly
  const r = l.submit({ key: 'k4', op: 'reverse', target: 'k2' });
  assert.equal(r.status, 'committed');
  assert.deepEqual(l.balance('alice'), { account: 'alice', balance: 100, frozen: 50, available: 50 });
  assert.equal(l.status('k2').reversedBy, 'k4');
  l.close();
});

test('reversal only affects the committed range: pending target rejected', () => {
  const dir = tempDir();
  const l1 = new Ledger(dir, { faultAfter: 'intent', initBalances: { alice: 100 } });
  l1.open();
  assert.throws(() => l1.submit({ key: 'k1', op: 'freeze', account: 'alice', amount: 40 }), CrashError);

  const l2 = new Ledger(dir).open();
  assert.equal(l2.status('k1').status, 'pending');
  assert.throws(() => l2.submit({ key: 'k2', op: 'reverse', target: 'k1' }), (err) => err.code === E_INVARIANT);
  assert.equal(l2.status('k2').status, 'aborted');
  assert.deepEqual(l2.balance('alice'), { account: 'alice', balance: 100, frozen: 0, available: 100 });
  l2.close();
});

test('reversal only affects the committed range: rolled-back target rejected', () => {
  const dir = tempDir();
  const l1 = new Ledger(dir, { faultAfter: 'applied', initBalances: { alice: 100 } });
  l1.open();
  assert.throws(() => l1.submit({ key: 'k1', op: 'freeze', account: 'alice', amount: 40 }), CrashError);

  const l2 = new Ledger(dir).open();
  assert.equal(l2.status('k1').status, 'aborted');
  assert.throws(() => l2.submit({ key: 'k2', op: 'reverse', target: 'k1' }), (err) => err.code === E_INVARIANT);
  assert.deepEqual(l2.balance('alice'), { account: 'alice', balance: 100, frozen: 0, available: 100 });
  l2.close();
});

test('double reversal and reversal-of-reversal are rejected', () => {
  const dir = tempDir();
  const l = openWith({ alice: 100 }, dir);
  l.submit({ key: 'k1', op: 'freeze', account: 'alice', amount: 40 });
  l.submit({ key: 'k2', op: 'reverse', target: 'k1' });
  assert.deepEqual(l.balance('alice'), { account: 'alice', balance: 100, frozen: 0, available: 100 });

  assert.throws(() => l.submit({ key: 'k3', op: 'reverse', target: 'k1' }), (err) => err.code === E_INVARIANT);
  assert.throws(() => l.submit({ key: 'k4', op: 'reverse', target: 'k2' }), (err) => err.code === E_INVARIANT);
  assert.deepEqual(l.balance('alice'), { account: 'alice', balance: 100, frozen: 0, available: 100 });
  l.close();
});

test('reversal replay after restart is idempotent', () => {
  const dir = tempDir();
  const l1 = openWith({ alice: 100 }, dir);
  l1.submit({ key: 'k1', op: 'freeze', account: 'alice', amount: 40 });
  l1.submit({ key: 'k2', op: 'reverse', target: 'k1' });
  l1.close();

  const l2 = new Ledger(dir).open();
  assert.equal(l2.status('k2').status, 'committed');
  assert.equal(l2.status('k1').reversedBy, 'k2');
  assert.deepEqual(l2.balance('alice'), { account: 'alice', balance: 100, frozen: 0, available: 100 });
  // resubmitting the reversal key does not apply twice
  const r = l2.submit({ key: 'k2', op: 'reverse', target: 'k1' });
  assert.equal(r.deduplicated, true);
  assert.equal(l2.balance('alice').frozen, 0);
  l2.close();
});
