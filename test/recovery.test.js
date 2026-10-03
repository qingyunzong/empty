import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Ledger, CrashError } from '../src/ledger.js';
import { tempDir } from './helpers.js';

function walRecords(dir) {
  return fs
    .readFileSync(path.join(dir, 'wal.log'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test('fault after intent: recovers as retryable PENDING, never failed', () => {
  const dir = tempDir();
  const l1 = new Ledger(dir, { faultAfter: 'intent', initBalances: { alice: 100 } });
  l1.open();
  assert.throws(() => l1.submit({ key: 'k1', op: 'freeze', account: 'alice', amount: 40 }), CrashError);

  const l2 = new Ledger(dir).open();
  const st = l2.status('k1');
  assert.equal(st.status, 'pending'); // PENDING is not a failure
  assert.notEqual(st.status, 'failed');
  assert.deepEqual(l2.balance('alice'), { account: 'alice', balance: 100, frozen: 0, available: 100 });

  // retry with the same key resumes and commits
  const res = l2.submit({ key: 'k1', op: 'freeze', account: 'alice', amount: 40 });
  assert.equal(res.status, 'committed');
  assert.deepEqual(l2.balance('alice'), { account: 'alice', balance: 100, frozen: 40, available: 60 });
  l2.close();

  // recovery is deterministic: reopening again yields the same outcome
  const l3 = new Ledger(dir).open();
  assert.equal(l3.status('k1').status, 'committed');
  assert.deepEqual(l3.balance('alice'), { account: 'alice', balance: 100, frozen: 40, available: 60 });
  l3.close();
});

test('fault after applied (uncommitted): automatic rollback on recovery', () => {
  const dir = tempDir();
  const l1 = new Ledger(dir, { faultAfter: 'applied', initBalances: { alice: 100 } });
  l1.open();
  assert.throws(() => l1.submit({ key: 'k1', op: 'freeze', account: 'alice', amount: 40 }), CrashError);

  const l2 = new Ledger(dir).open();
  const st = l2.status('k1');
  assert.equal(st.status, 'aborted');
  assert.match(st.reason, /rolled-back/);
  // effect fully rolled back, invariants hold
  assert.deepEqual(l2.balance('alice'), { account: 'alice', balance: 100, frozen: 0, available: 100 });
  // rollback is recorded in the WAL
  const aborts = walRecords(dir).filter((r) => r.type === 'abort');
  assert.equal(aborts.length, 1);

  // resubmitting the same key deterministically returns the recorded abort
  const again = l2.submit({ key: 'k1', op: 'freeze', account: 'alice', amount: 40 });
  assert.equal(again.status, 'aborted');
  assert.equal(again.deduplicated, true);
  // a fresh key works normally
  const res = l2.submit({ key: 'k2', op: 'freeze', account: 'alice', amount: 40 });
  assert.equal(res.status, 'committed');
  assert.equal(l2.balance('alice').frozen, 40);
  l2.close();

  // recovery is idempotent: a second recovery does not append another abort
  const l3 = new Ledger(dir).open();
  assert.equal(l3.status('k1').status, 'aborted');
  assert.equal(walRecords(dir).filter((r) => r.type === 'abort').length, 1);
  l3.close();
});

test('fault after commit: effective, replay idempotent', () => {
  const dir = tempDir();
  const l1 = new Ledger(dir, { faultAfter: 'commit', initBalances: { alice: 100 } });
  l1.open();
  assert.throws(() => l1.submit({ key: 'k1', op: 'freeze', account: 'alice', amount: 40 }), CrashError);

  const l2 = new Ledger(dir).open();
  assert.equal(l2.status('k1').status, 'committed');
  assert.deepEqual(l2.balance('alice'), { account: 'alice', balance: 100, frozen: 40, available: 60 });

  // duplicate submit of the same key returns the recorded result, no double apply
  const res = l2.submit({ key: 'k1', op: 'freeze', account: 'alice', amount: 40 });
  assert.equal(res.status, 'committed');
  assert.equal(res.deduplicated, true);
  assert.equal(l2.balance('alice').frozen, 40);
  l2.close();

  const l3 = new Ledger(dir).open();
  assert.equal(l3.status('k1').status, 'committed');
  assert.equal(l3.balance('alice').frozen, 40);
  l3.close();
});

test('all three fault points in one WAL recover deterministically', () => {
  const dir = tempDir();
  new Ledger(dir, { initBalances: { alice: 100, bob: 50 } }).open().close();

  for (const [key, point, account, amount] of [
    ['k-intent', 'intent', 'alice', 10],
    ['k-applied', 'applied', 'alice', 20],
    ['k-commit', 'commit', 'bob', 5],
  ]) {
    const l = new Ledger(dir, { faultAfter: point });
    l.open();
    assert.throws(() => l.submit({ key, op: 'freeze', account, amount }), CrashError);
  }

  const l = new Ledger(dir).open();
  assert.equal(l.status('k-intent').status, 'pending');
  assert.equal(l.status('k-applied').status, 'aborted');
  assert.equal(l.status('k-commit').status, 'committed');
  assert.deepEqual(l.balance('alice'), { account: 'alice', balance: 100, frozen: 0, available: 100 });
  assert.deepEqual(l.balance('bob'), { account: 'bob', balance: 50, frozen: 5, available: 45 });
  l.close();
});
