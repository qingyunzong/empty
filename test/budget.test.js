'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const budget = require('../lib/budget');
const { rollbackBatch } = require('../lib/rollback');
const { Store } = require('../lib/store');
const { ERR } = require('../lib/errors');

const BANK_HEADER = 'receiptId,batchId,amount,currency,timestamp,confirmed\n';

function makeDir(batchesCsv, bankCsv = BANK_HEADER) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-'));
  fs.writeFileSync(path.join(dir, 'batches.csv'), batchesCsv);
  fs.writeFileSync(path.join(dir, 'bank.csv'), bankCsv);
  return dir;
}

const TWO_BATCHES = [
  'batchId,parentId,layer,customerId,amount,currency,date',
  'B1,,1,C1,600,CNY,2026-10-01',
  'B2,,1,C1,500,CNY,2026-10-01',
  '',
].join('\n');

test('budget apply within limit succeeds; exceeding fails atomically with code=22', () => {
  const store = new Store(makeDir(TWO_BATCHES)).load();
  budget.setLimit(store.budgets, 'C1', '2026-10-01', 1000);
  store.saveBudgets();

  const ok = budget.applyBatch(store, 'B1');
  assert.equal(ok.applied, true);
  assert.equal(budget.usageOf(store.budgets, 'C1', '2026-10-01'), 600);

  assert.throws(() => budget.applyBatch(store, 'B2'), (err) => err.code === ERR.BUDGET_EXCEEDED);
  assert.equal(budget.usageOf(store.budgets, 'C1', '2026-10-01'), 600);
  const b2 = store.batches.find((b) => b.batchId === 'B2');
  assert.equal(b2.budgetApplied, false);

  const reloaded = new Store(store.dir).load();
  assert.equal(budget.usageOf(reloaded.budgets, 'C1', '2026-10-01'), 600);
});

test('crash after budget update before rollback marker: recovery does not double-deduct', () => {
  const dir = makeDir(TWO_BATCHES);
  const store = new Store(dir).load();
  budget.setLimit(store.budgets, 'C1', '2026-10-01', 1000);
  store.saveBudgets();
  budget.applyBatch(store, 'B1');
  assert.equal(budget.usageOf(store.budgets, 'C1', '2026-10-01'), 600);

  assert.throws(
    () => rollbackBatch(store, 'B1', { failAfter: 'budget' }),
    (err) => err.simulated === true
  );

  const mid = new Store(dir).load();
  assert.equal(budget.usageOf(mid.budgets, 'C1', '2026-10-01'), 0);
  assert.equal(mid.batches.find((b) => b.batchId === 'B1').status, 'rolled_back');

  const again = rollbackBatch(mid, 'B1');
  assert.equal(budget.usageOf(mid.budgets, 'C1', '2026-10-01'), 0);
  assert.deepEqual(again.rolledBack, ['B1']);

  const finalStore = new Store(dir).load();
  assert.equal(budget.usageOf(finalStore.budgets, 'C1', '2026-10-01'), 0);
  assert.equal(finalStore.batches.find((b) => b.batchId === 'B1').status, 'rolled_back');
});

test('rollback restores budget exactly once for applied batch', () => {
  const store = new Store(makeDir(TWO_BATCHES)).load();
  budget.setLimit(store.budgets, 'C1', '2026-10-01', 1000);
  store.saveBudgets();
  budget.applyBatch(store, 'B1');
  rollbackBatch(store, 'B1');
  assert.equal(budget.usageOf(store.budgets, 'C1', '2026-10-01'), 0);
  assert.throws(() => budget.applyDelta(store.budgets, 'C1', '2026-10-01', -1), (err) => err.code === ERR.BUDGET_EXCEEDED);
});
