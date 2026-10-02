'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  EMPTY_STATE, loadState, saveState, rollback, setLimit, getNet, ERR_BUDGET,
} = require('../src');

const batch = (id, parentId, customerId, amount, extra = {}) => ({
  batchId: id, layer: 'channel', parentId, customerId, amount,
  currency: 'CNY', date: '2026-10-03', status: 'active', bankConfirmed: false, ...extra,
});

test('budget exceeded: whole batch fails with code 22, no partial deduction', () => {
  const state = EMPTY_STATE();
  state.batches = [
    batch('P', null, 'C1', 8000),
    batch('K1', 'P', 'C1', 5000),
    batch('K2', 'P', 'C2', 1000),
  ];
  setLimit(state, 'C1', '2026-10-03', 10000); // rollback would move net to -13000
  assert.throws(() => rollback(state, 'P'), (e) => {
    assert.equal(e.code, ERR_BUDGET);
    assert.match(e.message, /whole batch rejected/);
    return true;
  });
  // nothing changed: no status flipped, no budget touched, no journal left
  assert.ok(state.batches.every((b) => b.status === 'active'));
  assert.deepEqual(state.budgets, {});
  assert.equal(state.journal, null);
});

test('budget exactly at the limit succeeds', () => {
  const state = EMPTY_STATE();
  state.batches = [batch('P', null, 'C1', 8000)];
  setLimit(state, 'C1', '2026-10-03', 8000);
  const r = rollback(state, 'P');
  assert.deepEqual(r.rolledBack, ['P']);
  assert.equal(getNet(state, 'C1', '2026-10-03'), -8000);
});

test('acceptance 3: crash after budget update, recovery does not double-deduct', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-'));
  const stateFile = path.join(dir, 'state.json');
  const persist = (s) => saveState(stateFile, s);

  const state = EMPTY_STATE();
  state.batches = [
    batch('P', null, 'C1', 8000),
    batch('K1', 'P', 'C1', 2000),
  ];
  setLimit(state, 'C1', '2026-10-03', 100000);

  // crash right after the budget update is persisted, before rollback markers
  assert.throws(
    () => rollback(state, 'P', { persist, crashAfterBudget: true }),
    (e) => e.simulated === true,
  );

  // recover from disk: journal says budget was applied, markers are missing
  const recovered = loadState(stateFile);
  assert.equal(recovered.journal.phase, 'budget_applied');
  assert.equal(getNet(recovered, 'C1', '2026-10-03'), -10000);
  assert.ok(recovered.batches.every((b) => b.status === 'active'));

  // resume the rollback: budget must NOT be applied a second time
  const result = rollback(recovered, 'P', { persist });
  assert.equal(result.resumed, true);
  assert.deepEqual(new Set(result.rolledBack), new Set(['P', 'K1']));
  assert.equal(getNet(recovered, 'C1', '2026-10-03'), -10000); // no double deduction
  assert.equal(recovered.journal.phase, 'done'); // completion marker kept for idempotency

  // a further rollback is a no-op
  const again = rollback(loadState(stateFile), 'P', { persist });
  assert.equal(again.alreadyDone, true);
  assert.equal(getNet(loadState(stateFile), 'C1', '2026-10-03'), -10000);
});
