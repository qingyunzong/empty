import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { BudgetService } from '../src/budget.js';
import { CONFLICT, BUDGET_EXCEEDED, NO_ACCOUNT } from '../src/errors.js';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mvcc-'));

test('snapshot isolation: reader does not see later commits', async () => {
  const store = Store.open(tmpdir());
  const svc = new BudgetService(store);
  await svc.createAccount('a', 100);

  const reader = store.begin();
  assert.equal(reader.get('acct/a').balance, 100);

  await svc.debit('a', 40);

  // Old snapshot still sees 100; a fresh snapshot sees 60.
  assert.equal(reader.get('acct/a').balance, 100);
  assert.equal(store.begin().get('acct/a').balance, 60);
});

test('write-write conflict: intersecting write sets -> CONFLICT', async () => {
  const store = Store.open(tmpdir());
  const svc = new BudgetService(store);
  await svc.createAccount('a', 100);

  const t1 = store.begin();
  const t2 = store.begin();
  t1.debit('acct/a', 10);
  t2.debit('acct/a', 20);
  await t1.commit();
  await assert.rejects(() => t2.commit(), (e) => e.code === CONFLICT);
  // Loser's debit never applied.
  assert.equal(svc.balance('a'), 90);
});

test('BUDGET_EXCEEDED aborts the whole transaction: no partial effects', async () => {
  const store = Store.open(tmpdir());
  const svc = new BudgetService(store);
  await svc.createAccount('a', 50);

  await assert.rejects(() => svc.debit('a', 80, 'too-big'), (e) => e.code === BUDGET_EXCEEDED);
  // Balance untouched and no usage record written.
  assert.equal(svc.balance('a'), 50);
  assert.equal(svc.usage('a').length, 0);
});

test('NO_ACCOUNT for missing accounts', async () => {
  const svc = new BudgetService(tmpdir());
  assert.throws(() => svc.balance('ghost'), (e) => e.code === NO_ACCOUNT);
  await assert.rejects(() => svc.debit('ghost', 1), (e) => e.code === NO_ACCOUNT);
});

test('durability: committed state survives reopen', async () => {
  const dir = tmpdir();
  const svc = new BudgetService(dir);
  await svc.createAccount('a', 100);
  await svc.debit('a', 30, 'run-1');

  const reopened = new BudgetService(dir);
  assert.equal(reopened.balance('a'), 70);
  assert.equal(reopened.usage('a').length, 1);
  assert.equal(reopened.history().length, 2);
});
