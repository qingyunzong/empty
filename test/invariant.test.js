import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, E_INVARIANT } from '../src/ledger.js';
import { tempDir } from './helpers.js';

test('over-freeze violates invariant: E_INVARIANT, tx aborted, state unchanged', () => {
  const dir = tempDir();
  const l = new Ledger(dir, { initBalances: { alice: 100 } }).open();
  assert.throws(() => l.submit({ key: 'k1', op: 'freeze', account: 'alice', amount: 150 }), (err) => err.code === E_INVARIANT);
  assert.equal(l.status('k1').status, 'aborted');
  assert.deepEqual(l.balance('alice'), { account: 'alice', balance: 100, frozen: 0, available: 100 });
  // abort decision is durable and deterministic across restart
  l.close();
  const l2 = new Ledger(dir).open();
  assert.equal(l2.status('k1').status, 'aborted');
  const again = l2.submit({ key: 'k1', op: 'freeze', account: 'alice', amount: 150 });
  assert.equal(again.status, 'aborted');
  l2.close();
});

test('debit/release beyond frozen are rejected with E_INVARIANT', () => {
  const dir = tempDir();
  const l = new Ledger(dir, { initBalances: { alice: 100 } }).open();
  assert.throws(() => l.submit({ key: 'd1', op: 'debit', account: 'alice', amount: 10 }), (err) => err.code === E_INVARIANT);
  assert.throws(() => l.submit({ key: 'r1', op: 'release', account: 'alice', amount: 10 }), (err) => err.code === E_INVARIANT);
  l.submit({ key: 'f1', op: 'freeze', account: 'alice', amount: 60 });
  assert.throws(() => l.submit({ key: 'd2', op: 'debit', account: 'alice', amount: 61 }), (err) => err.code === E_INVARIANT);
  assert.throws(() => l.submit({ key: 'r2', op: 'release', account: 'alice', amount: 61 }), (err) => err.code === E_INVARIANT);
  assert.deepEqual(l.balance('alice'), { account: 'alice', balance: 100, frozen: 60, available: 40 });
  l.close();
});

test('invariants hold after every commit in a mixed sequence', () => {
  const dir = tempDir();
  const l = new Ledger(dir, { initBalances: { alice: 100 } }).open();
  const check = () => {
    const b = l.balance('alice');
    assert.ok(b.balance >= 0 && b.frozen >= 0 && b.available >= 0);
    assert.equal(b.available, b.balance - b.frozen);
  };
  l.submit({ key: '1', op: 'freeze', account: 'alice', amount: 70 });
  check();
  l.submit({ key: '2', op: 'debit', account: 'alice', amount: 30 });
  check();
  l.submit({ key: '3', op: 'release', account: 'alice', amount: 40 });
  check();
  l.submit({ key: '4', op: 'reverse', target: '2' });
  check();
  assert.deepEqual(l.balance('alice'), { account: 'alice', balance: 100, frozen: 30, available: 70 });
  l.close();
});

test('invalid input is a TypeError, not a ledger error', () => {
  const dir = tempDir();
  const l = new Ledger(dir, { initBalances: { alice: 100 } }).open();
  assert.throws(() => l.submit({ key: '', op: 'freeze', account: 'alice', amount: 1 }), TypeError);
  assert.throws(() => l.submit({ key: 'x', op: 'freeze', account: 'alice', amount: -5 }), TypeError);
  assert.throws(() => l.submit({ key: 'x', op: 'freeze', account: 'alice', amount: 1.5 }), TypeError);
  assert.throws(() => l.submit({ key: 'x', op: 'nope', account: 'alice', amount: 1 }), TypeError);
  l.close();
});
