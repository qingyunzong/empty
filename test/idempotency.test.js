import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, E_WAL } from '../src/ledger.js';
import { tempDir } from './helpers.js';

test('duplicate submit with the same key is idempotent', () => {
  const dir = tempDir();
  const l = new Ledger(dir, { initBalances: { alice: 100 } }).open();
  const r1 = l.submit({ key: 'k1', op: 'freeze', account: 'alice', amount: 30 });
  const r2 = l.submit({ key: 'k1', op: 'freeze', account: 'alice', amount: 30 });
  assert.equal(r1.status, 'committed');
  assert.equal(r2.status, 'committed');
  assert.equal(r2.txId, r1.txId);
  assert.equal(r2.deduplicated, true);
  assert.equal(l.balance('alice').frozen, 30); // applied exactly once
  l.close();
});

test('duplicate submit survives restart', () => {
  const dir = tempDir();
  const l1 = new Ledger(dir, { initBalances: { alice: 100 } }).open();
  const r1 = l1.submit({ key: 'k1', op: 'freeze', account: 'alice', amount: 25 });
  l1.close();
  const l2 = new Ledger(dir).open();
  const r2 = l2.submit({ key: 'k1', op: 'freeze', account: 'alice', amount: 25 });
  assert.equal(r2.status, 'committed');
  assert.equal(r2.txId, r1.txId);
  assert.equal(r2.deduplicated, true);
  assert.equal(l2.balance('alice').frozen, 25);
  l2.close();
});

test('idempotency key reused with different parameters is rejected (E_WAL)', () => {
  const dir = tempDir();
  const l = new Ledger(dir, { initBalances: { alice: 100 } }).open();
  l.submit({ key: 'k1', op: 'freeze', account: 'alice', amount: 30 });
  assert.throws(() => l.submit({ key: 'k1', op: 'freeze', account: 'alice', amount: 31 }), (err) => err.code === E_WAL);
  assert.throws(() => l.submit({ key: 'k1', op: 'release', account: 'alice', amount: 30 }), (err) => err.code === E_WAL);
  assert.equal(l.balance('alice').frozen, 30);
  l.close();
});
