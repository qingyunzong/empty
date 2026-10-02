'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ledger = require('../src/ledger');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'settle-test-'));
}

function setupTree(dir) {
  // b1 (L0) -> b2 (L1) -> b3 (L2); b4 (L1) is an unrelated sibling of b2.
  ledger.propose(dir, {
    batchId: 'b1',
    transfers: [{ id: 't1', from: 'A', to: 'B', amount: 10 }],
    budgets: { A: 100 },
  });
  ledger.finalize(dir, { batchId: 'b1' });

  ledger.propose(dir, {
    batchId: 'b2',
    transfers: [{ id: 't2', from: 'B', to: 'C', amount: 10 }],
    budgets: { B: 100 },
  });
  ledger.finalize(dir, { batchId: 'b2', parentBatchId: 'b1' });

  ledger.propose(dir, {
    batchId: 'b3',
    transfers: [{ id: 't3', from: 'C', to: 'D', amount: 10 }],
    budgets: { C: 100 },
  });
  ledger.finalize(dir, { batchId: 'b3', parentBatchId: 'b2' });

  ledger.propose(dir, {
    batchId: 'b4',
    transfers: [{ id: 't4', from: 'D', to: 'A', amount: 5 }],
    budgets: { D: 100 },
  });
  ledger.finalize(dir, { batchId: 'b4', parentBatchId: 'b1' });
}

test('correcting a middle batch rolls back dependents, keeps unrelated final', () => {
  const dir = tmpDir();
  setupTree(dir);

  const before = ledger.load(dir);
  const b2 = before.findByBatch('b2');
  const b3 = before.findByBatch('b3');
  const b4 = before.findByBatch('b4');
  assert.ok(b2 && b3 && b4);

  const result = ledger.correct(dir, {
    batchId: 'b2',
    transfers: [{ id: 't2x', from: 'B', to: 'C', amount: 7 }],
    budgets: { B: 100 },
  });

  // Only the explicit dependent (b3) is rolled back.
  assert.deepEqual(result.rolledBack.map((d) => d.batchId), ['b3']);

  const after = ledger.load(dir);
  assert.equal(after.statusOf(b3.hash), 'rolledback');
  assert.equal(after.statusOf(b2.hash), 'corrected');
  assert.equal(after.statusOf(b4.hash), 'final', 'unrelated node must stay final');
  assert.equal(after.statusOf(result.chunk.hash), 'final');

  // The correction replaces b2 at the same level with the same parent.
  assert.equal(result.chunk.level, b2.level);
  assert.equal(result.chunk.parentHash, b2.parentHash);
  assert.equal(result.chunk.corrects, b2.hash);
  assert.deepEqual(result.chunk.transfers, ['t2x']);

  // b3 is no longer settleable/active; b4 still is.
  assert.equal(after.findByBatch('b3'), null);
  assert.ok(after.findByBatch('b4'));
});

test('correction re-selects under the reserved budget of the parent chain', () => {
  const dir = tmpDir();
  ledger.propose(dir, {
    batchId: 'b1',
    transfers: [{ id: 't1', from: 'A', to: 'B', amount: 60 }],
    budgets: { A: 100 },
  });
  ledger.finalize(dir, { batchId: 'b1' });
  ledger.propose(dir, {
    batchId: 'b2',
    transfers: [{ id: 't2', from: 'A', to: 'C', amount: 50 }],
    budgets: { A: 100 },
  });
  ledger.finalize(dir, { batchId: 'b2', parentBatchId: 'b1' });

  // A already committed 60 net outflow in b1, so only 40 remains.
  const result = ledger.correct(dir, {
    batchId: 'b2',
    transfers: [
      { id: 'x1', from: 'A', to: 'C', amount: 50 },
      { id: 'x2', from: 'A', to: 'D', amount: 40 },
    ],
    budgets: { A: 100 },
  });
  assert.deepEqual(result.chunk.transfers, ['x2']);
});

test('correcting a non-final batch is a business conflict', () => {
  const dir = tmpDir();
  assert.throws(
    () => ledger.correct(dir, { batchId: 'nope', transfers: [], budgets: {} }),
    /no final batch to correct/
  );
});

test('rollback cascades to explicit dependents only', () => {
  const dir = tmpDir();
  setupTree(dir);
  const r = ledger.rollback(dir, { batchId: 'b2' });
  assert.deepEqual(r.rolledBack.map((d) => d.batchId), ['b3']);
  const after = ledger.load(dir);
  assert.equal(after.findByBatch('b2'), null);
  assert.equal(after.findByBatch('b3'), null);
  assert.ok(after.findByBatch('b1'));
  assert.ok(after.findByBatch('b4'), 'unrelated branch stays final');
});
