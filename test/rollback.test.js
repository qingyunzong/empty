'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EMPTY_STATE, dependencyClosure, rollback, ERR_CYCLE, ERR_ORPHAN,
} = require('../src');

// Deterministic PRNG (LCG) so the 100-batch graph is reproducible.
function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

function makeBatches(n, seed = 42) {
  const rand = lcg(seed);
  const layers = ['channel', 'clearing', 'bank'];
  const batches = [{ batchId: 'B0', layer: 'channel', parentId: null, customerId: 'C0',
    amount: 1000, currency: 'CNY', date: '2026-10-03', status: 'active', bankConfirmed: false }];
  for (let i = 1; i < n; i++) {
    const parentIdx = Math.floor(rand() * i); // nested: parent always earlier
    batches.push({
      batchId: `B${i}`,
      layer: layers[i % 3],
      parentId: `B${parentIdx}`,
      customerId: `C${i % 5}`,
      amount: (i + 1) * 100,
      currency: 'CNY',
      date: '2026-10-03',
      status: 'active',
      bankConfirmed: false,
    });
  }
  return batches;
}

// Independent brute-force enumeration of the dependency closure (fixpoint).
function bruteForceClosure(batches, rootId) {
  const inSet = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of batches) {
      if (b.parentId != null && inSet.has(b.parentId) && !inSet.has(b.batchId)) {
        inSet.add(b.batchId);
        grew = true;
      }
    }
  }
  return inSet;
}

test('acceptance 1: 100 nested batches, closure matches brute-force enumeration for every root', () => {
  const batches = makeBatches(100);
  let small = 0;
  for (let i = 0; i < 100; i++) {
    const rootId = `B${i}`;
    const closure = dependencyClosure(batches, rootId).map((b) => b.batchId);
    const expected = bruteForceClosure(batches, rootId);
    assert.deepEqual(new Set(closure), expected, `closure mismatch for ${rootId}`);
    assert.equal(closure.length, expected.size);
    if (expected.size <= 9) small++; // n<=9 closures cross-checked by enumeration
  }
  assert.ok(small > 0, 'expected some closures with n<=9');
});

test('acceptance 1: rollback marks exactly the dependency closure', () => {
  const state = EMPTY_STATE();
  state.batches = makeBatches(100);
  const rootId = 'B7';
  const expected = bruteForceClosure(state.batches, rootId);
  const result = rollback(state, rootId);
  assert.deepEqual(new Set(result.rolledBack), expected);
  for (const b of state.batches) {
    assert.equal(b.status, expected.has(b.batchId) ? 'rolled_back' : 'active', b.batchId);
  }
});

test('acceptance 2: confirmed bank batch gets reversal adjustment, original status unchanged', () => {
  const state = EMPTY_STATE();
  state.batches = [
    { batchId: 'CH1', layer: 'channel', parentId: null, customerId: 'C1', amount: 5000, currency: 'CNY', date: '2026-10-03', status: 'active', bankConfirmed: false },
    { batchId: 'BK1', layer: 'bank', parentId: 'CH1', customerId: 'C1', amount: 5000, currency: 'CNY', date: '2026-10-03', status: 'active', bankConfirmed: true },
  ];
  const result = rollback(state, 'BK1');
  assert.deepEqual(result.rolledBack, []);
  assert.deepEqual(result.reversals, ['ADJ-BK1']);
  const bk = state.batches.find((b) => b.batchId === 'BK1');
  assert.equal(bk.status, 'active'); // original batch state unchanged
  assert.equal(bk.bankConfirmed, true);
  const adj = state.adjustments.find((a) => a.id === 'ADJ-BK1');
  assert.equal(adj.type, 'reversal');
  assert.equal(adj.amount, -5000);
  assert.equal(adj.ofBatchId, 'BK1');
});

test('confirmed bank batch inside a closure: children rolled back, bank reversed', () => {
  const state = EMPTY_STATE();
  state.batches = [
    { batchId: 'CH1', layer: 'channel', parentId: null, customerId: 'C1', amount: 100, currency: 'CNY', date: '2026-10-03', status: 'active', bankConfirmed: false },
    { batchId: 'CL1', layer: 'clearing', parentId: 'CH1', customerId: 'C1', amount: 100, currency: 'CNY', date: '2026-10-03', status: 'active', bankConfirmed: false },
    { batchId: 'BK1', layer: 'bank', parentId: 'CL1', customerId: 'C1', amount: 100, currency: 'CNY', date: '2026-10-03', status: 'active', bankConfirmed: true },
  ];
  const result = rollback(state, 'CH1');
  assert.deepEqual(new Set(result.rolledBack), new Set(['CH1', 'CL1']));
  assert.deepEqual(result.reversals, ['ADJ-BK1']);
  assert.equal(state.batches.find((b) => b.batchId === 'BK1').status, 'active');
});

test('circular dependency rejected with code 20', () => {
  const state = EMPTY_STATE();
  state.batches = [
    { batchId: 'A', layer: 'channel', parentId: 'B', customerId: 'C1', amount: 1, currency: 'CNY', date: '2026-10-03', status: 'active', bankConfirmed: false },
    { batchId: 'B', layer: 'clearing', parentId: 'A', customerId: 'C1', amount: 1, currency: 'CNY', date: '2026-10-03', status: 'active', bankConfirmed: false },
  ];
  assert.throws(() => rollback(state, 'A'), (e) => e.code === ERR_CYCLE);
});

test('orphan bank receipt rejected with code 21', () => {
  const state = EMPTY_STATE();
  state.batches = [
    { batchId: 'BK9', layer: 'bank', parentId: 'MISSING', customerId: 'C1', amount: 1, currency: 'CNY', date: '2026-10-03', status: 'active', bankConfirmed: false },
  ];
  assert.throws(() => rollback(state, 'BK9'), (e) => e.code === ERR_ORPHAN);
});

test('rollback is idempotent', () => {
  const state = EMPTY_STATE();
  state.batches = [
    { batchId: 'CH1', layer: 'channel', parentId: null, customerId: 'C1', amount: 100, currency: 'CNY', date: '2026-10-03', status: 'active', bankConfirmed: false },
  ];
  rollback(state, 'CH1');
  const again = rollback(state, 'CH1');
  assert.deepEqual(again.rolledBack, []);
  assert.equal(state.budgets['C1|2026-10-03'], -100); // applied exactly once
});
