import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { BudgetService } from '../src/budget.js';
import { CrashError } from '../src/errors.js';

// Acceptance scenario (2): a debit transaction crashes while its WAL commit
// record is half-written. After restart, the account balance and the usage
// record must be both-present or both-absent -- never one without the other.
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wal-'));

async function setup() {
  const dir = tmpdir();
  const svc = new BudgetService(dir);
  await svc.createAccount('a', 100);
  return { dir, svc };
}

test('crash mid-commit-record: balance and usage record both absent after recovery', async () => {
  const { dir, svc } = await setup();

  // Build the debit transaction manually so we can inject the crash hook.
  const tx = svc.store.begin();
  tx.debit('acct/a', 40);
  tx.put('usage/victim', { account: 'a', amount: 40, note: 'crash', ts: Date.now() });
  await assert.rejects(
    () => tx.commit({ crashAfterBytes: 25 }), // torn: header + partial payload
    (e) => e instanceof CrashError,
  );

  // Simulate process crash: discard in-memory state, reopen from disk.
  const recovered = new BudgetService(dir);
  assert.equal(recovered.balance('a'), 100, 'balance rolled back');
  assert.equal(recovered.usage('a').length, 0, 'usage record rolled back with it');
});

test('crash after full commit record but before in-memory apply: both present after recovery', async () => {
  const { dir, svc } = await setup();

  const tx = svc.store.begin();
  tx.debit('acct/a', 40);
  tx.put('usage/durable', { account: 'a', amount: 40, note: 'ok', ts: Date.now() });
  await assert.rejects(
    () => tx.commit({ crashAfterBytes: Number.MAX_SAFE_INTEGER }), // full record, then crash
    (e) => e instanceof CrashError,
  );

  const recovered = new BudgetService(dir);
  assert.equal(recovered.balance('a'), 60, 'balance recovered from WAL');
  const usage = recovered.usage('a');
  assert.equal(usage.length, 1, 'usage record recovered with it');
  assert.equal(usage[0].amount, 40);
});

test('torn tail does not corrupt earlier commits; store keeps working after recovery', async () => {
  const { dir, svc } = await setup();
  await svc.debit('a', 10, 'good-1');

  const tx = svc.store.begin();
  tx.debit('acct/a', 20);
  tx.put('usage/torn', { account: 'a', amount: 20, note: 'torn', ts: Date.now() });
  await assert.rejects(() => tx.commit({ crashAfterBytes: 7 }), (e) => e instanceof CrashError);

  const recovered = new BudgetService(dir);
  assert.equal(recovered.balance('a'), 90);
  assert.equal(recovered.usage('a').length, 1);

  // New transactions still commit cleanly on top of the recovered log.
  await recovered.debit('a', 5, 'good-2');
  const again = new BudgetService(dir);
  assert.equal(again.balance('a'), 85);
  assert.equal(again.usage('a').length, 2);
});
