'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { loadState } = require('../src/store');
const { allocateOrder } = require('../src/allocator');
const { run, EXIT } = require('../bin/alloc');

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function makeWorkspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alloc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'state.json');
  const orderFile = path.join(dir, 'order.json');
  const state = {
    config: { transferCostPerUnit: 5 },
    batches: [
      { id: 'B1', material: 'M1', quantity: 4, allocated: 0, expiryDate: '2026-11-01', qualityStatus: 'released', location: 'L1' },
      { id: 'B2', material: 'M1', quantity: 3, allocated: 0, expiryDate: '2026-12-01', qualityStatus: 'released', location: 'L1' },
      { id: 'B3', material: 'M1', quantity: 5, allocated: 0, expiryDate: '2026-10-15', qualityStatus: 'released', location: 'L2' },
    ],
    orders: [],
  };
  const order = { id: 'O1', material: 'M1', quantity: 9, location: 'L1', date: '2026-10-01' };
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  fs.writeFileSync(orderFile, JSON.stringify(order, null, 2));
  return { stateFile, orderFile };
}

/** Invoke the CLI in-process, capturing stdout/stderr and the exit code. */
function runCli(argv) {
  const out = [];
  const err = [];
  const code = run(argv, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

test('crash before rename: exit 3, state.json hash unchanged, retry succeeds', (t) => {
  const { stateFile, orderFile } = makeWorkspace(t);
  const beforeHash = hashFile(stateFile);

  const crashed = runCli(['allocate', '--state', stateFile, '--order', orderFile, '--fail-before-rename']);
  assert.equal(crashed.code, EXIT.PERSIST_FAILED, `expected exit 3: ${crashed.stderr}`);
  assert.match(crashed.stderr, /persist-failed/);
  assert.match(crashed.stderr, /fail-before-rename/);
  assert.match(crashed.stderr, /"rolledBack":true/);

  // original file byte-identical, no temp file left behind
  assert.equal(hashFile(stateFile), beforeHash, 'state.json hash must be unchanged');
  assert.deepEqual(fs.readdirSync(path.dirname(stateFile)).filter((f) => f.includes('.tmp-')), []);

  // retry without the fault injection -> complete result
  const retried = runCli(['allocate', '--state', stateFile, '--order', orderFile]);
  assert.equal(retried.code, EXIT.OK, `expected exit 0: ${retried.stderr}`);
  const out = JSON.parse(retried.stdout);
  assert.equal(out.status, 'optimal');
  assert.equal(out.allocations.reduce((a, x) => a + x.quantity, 0), 9);

  const persisted = loadState(stateFile);
  assert.equal(persisted.orders.length, 1);
  assert.equal(persisted.orders[0].id, 'O1');
  const allocatedTotal = persisted.batches.reduce((a, b) => a + b.allocated, 0);
  assert.equal(allocatedTotal, 9, 'all 9 units allocated exactly once after retry');
});

test('in-memory allocation rolls back when persistence fails', () => {
  const state = {
    batches: [
      { id: 'B1', material: 'M1', quantity: 4, allocated: 1, expiryDate: '2026-11-01', qualityStatus: 'released', location: 'L1' },
    ],
    orders: [],
  };
  const snapshot = JSON.parse(JSON.stringify(state));
  const order = { id: 'O9', material: 'M1', quantity: 2, location: 'L1', date: '2026-10-01' };
  const { status, rolledBack } = allocateOrder(state, order, {
    persist: true,
    stateFile: path.join(os.tmpdir(), 'never-written-state.json'),
    failBeforeRename: true,
  });
  assert.equal(status, 'persist-failed');
  assert.equal(rolledBack, true);
  assert.deepEqual(state, snapshot, 'in-memory state fully restored after rollback');
});

test('infeasible order exits 1 with conflicts and does not touch state.json', (t) => {
  const { stateFile, orderFile } = makeWorkspace(t);
  fs.writeFileSync(orderFile, JSON.stringify({ id: 'OBIG', material: 'M1', quantity: 500, location: 'L1', date: '2026-10-01' }));
  const beforeHash = hashFile(stateFile);
  const run1 = runCli(['allocate', '--state', stateFile, '--order', orderFile]);
  assert.equal(run1.code, EXIT.INFEASIBLE);
  const out = JSON.parse(run1.stdout);
  assert.equal(out.status, 'infeasible');
  assert.ok(out.conflicts.some((c) => c.reason === 'insufficient-quantity'));
  assert.equal(hashFile(stateFile), beforeHash);
});

test('budget exhaustion exits 2 with unknown', (t) => {
  const { stateFile, orderFile } = makeWorkspace(t);
  const beforeHash = hashFile(stateFile);
  const run2 = runCli(['allocate', '--state', stateFile, '--order', orderFile, '--budget', '1']);
  assert.equal(run2.code, EXIT.UNKNOWN);
  assert.match(run2.stdout, /budget-exhausted/);
  assert.equal(hashFile(stateFile), beforeHash);
});
