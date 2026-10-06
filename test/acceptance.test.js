'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPlan, applyCancellations } = require('../lib/plan');
const sm = require('../lib/state');

const B1 = { id: 'B1', start: '2026-10-06T09:00:00Z', end: '2026-10-06T10:00:00Z' };
const B2 = { id: 'B2', start: '2026-10-06T10:00:00Z', end: '2026-10-06T11:00:00Z' };

test('acceptance 1: three transactions split across batches succeed', () => {
  const input = {
    accounts: [{ id: 'A', limit: 100 }],
    batches: [B1, B2],
    transactions: [
      { id: 'T1', account: 'A', amount: 60 },
      { id: 'T2', account: 'A', amount: 60 },
      { id: 'T3', account: 'A', amount: 40 },
    ],
  };
  const out = buildPlan(input);
  assert.equal(out.status, 'SAT');
  const all = out.plan.flatMap((b) => b.retries.map((r) => r.tx)).sort();
  assert.deepEqual(all, ['T1', 'T2', 'T3']);
  // Same account, same batch: tentative freeze never exceeds the limit.
  for (const batch of out.plan) {
    assert.ok((batch.frozenByAccount.A || 0) <= 100, `batch ${batch.batch} over limit`);
  }
  // Limit 100 forces a split: both batches are used.
  const usedBatches = out.plan.filter((b) => b.retries.length > 0).map((b) => b.batch);
  assert.deepEqual(usedBatches, ['B1', 'B2']);
});

test('acceptance 1b: retries only land in allowed time windows', () => {
  const input = {
    accounts: [{ id: 'A', limit: 1000 }],
    batches: [B1, B2],
    transactions: [
      { id: 'T1', account: 'A', amount: 10, windows: ['B2'] },
      { id: 'T2', account: 'A', amount: 10 },
    ],
  };
  const out = buildPlan(input);
  assert.equal(out.status, 'SAT');
  const t1Batch = out.plan.find((b) => b.retries.some((r) => r.tx === 'T1')).batch;
  assert.equal(t1Batch, 'B2');
});

test('acceptance 2: cancellation incrementally deletes future batches, running batch handled after', () => {
  const input = {
    accounts: [{ id: 'A', limit: 100 }],
    batches: [B1, B2],
    transactions: [
      { id: 'T1', account: 'A', amount: 60 },
      { id: 'T2', account: 'A', amount: 60 },
      { id: 'T3', account: 'A', amount: 40 },
    ],
  };
  const first = buildPlan(input);
  assert.equal(first.status, 'SAT');

  // Incremental: cancel T2 against the existing plan; B1 is running, B2 pending.
  const batchStatus = new Map([['B1', 'running'], ['B2', 'pending']]);
  const planCopy = first.plan.map((b) => ({ ...b, retries: b.retries.map((r) => ({ ...r })) }));
  const { removed, marked } = applyCancellations(planCopy, ['T2'], batchStatus);
  // Not-started batch: retry deleted outright.
  for (const r of removed) assert.equal(r.tx, 'T2');
  const pendingBatch = planCopy.find((b) => b.batch === 'B2');
  assert.ok(!pendingBatch.retries.some((r) => r.tx === 'T2'));
  // Running batch: retry marked CANCELLED, not deleted.
  const runningBatch = planCopy.find((b) => b.batch === 'B1');
  const t2 = runningBatch.retries.find((r) => r.tx === 'T2');
  if (t2) assert.equal(t2.state, 'CANCELLED');
  for (const m of marked) assert.equal(m.tx, 'T2');

  // Replanning excludes the cancelled transaction from all future batches.
  const replanned = buildPlan({ ...input, cancellations: ['T2'] });
  assert.equal(replanned.status, 'SAT');
  const remaining = replanned.plan.flatMap((b) => b.retries.map((r) => r.tx)).sort();
  assert.deepEqual(remaining, ['T1', 'T3']);
});

test('acceptance 3: crash recovery returns RUNNING-without-freeze to PENDING', () => {
  const input = {
    accounts: [{ id: 'A', limit: 100 }],
    batches: [B1, B2],
    transactions: [{ id: 'T1', account: 'A', amount: 50 }],
    state: {
      retries: {
        r1: { txId: 'T1', batchId: 'B1', state: 'RUNNING', freezeCommitted: false },
      },
    },
  };
  const out = buildPlan(input);
  assert.equal(out.status, 'SAT');
  assert.deepEqual(out.recovered, [{ tx: 'T1', batch: 'B1', state: 'PENDING' }]);
  assert.equal(input.state.retries.r1.state, 'PENDING');
  // Safe retry is possible from PENDING.
  sm.begin(input.state.retries.r1);
  assert.equal(input.state.retries.r1.state, 'RUNNING');
});

test('acceptance 3b: recovery never fakes success', () => {
  const crashed = { txId: 'T1', batchId: 'B1', state: 'RUNNING', freezeCommitted: false };
  assert.throws(() => sm.succeed(crashed), /committed freeze/);
  const state = { retries: { r1: crashed } };
  const recovered = sm.recover(state);
  assert.equal(recovered.length, 1);
  assert.equal(crashed.state, 'PENDING');
  assert.notEqual(crashed.state, 'SUCCESS');
  // A committed freeze may legitimately succeed.
  sm.begin(crashed);
  sm.commitFreeze(crashed);
  sm.succeed(crashed);
  assert.equal(crashed.state, 'SUCCESS');
  // Success is permanent: no further retry.
  assert.throws(() => sm.begin(crashed));
  const replanned = buildPlan({
    accounts: [{ id: 'A', limit: 100 }],
    batches: [B1, B2],
    transactions: [{ id: 'T1', account: 'A', amount: 50 }],
    state: { retries: { r1: { txId: 'T1', batchId: 'B1', state: 'SUCCESS', freezeCommitted: true } } },
  });
  assert.deepEqual(replanned.skippedSucceeded, ['T1']);
  assert.equal(replanned.plan.flatMap((b) => b.retries).length, 0);
});

test('acceptance 4: insufficient limit is UNSAT with minimal account-batch conflict', () => {
  const input = {
    accounts: [{ id: 'A', limit: 50 }],
    batches: [B1, B2],
    transactions: [
      { id: 'T1', account: 'A', amount: 40 },
      { id: 'T2', account: 'A', amount: 40 },
      { id: 'T3', account: 'A', amount: 40 },
    ],
  };
  const out = buildPlan(input);
  assert.equal(out.status, 'UNSAT');
  assert.ok(Array.isArray(out.conflict));
  assert.ok(out.conflict.length > 0);
  for (const c of out.conflict) {
    assert.equal(c.account, 'A');
    assert.ok(['B1', 'B2'].includes(c.batch));
  }
  // Total capacity 2*50=100 < 120, and both batch constraints are needed to
  // explain infeasibility (relaxing either makes it SAT).
  assert.deepEqual(out.conflict, [
    { account: 'A', batch: 'B1' },
    { account: 'A', batch: 'B2' },
  ]);
});

test('acceptance 4b: infeasible routing (empty window set) propagates to UNSAT', () => {
  const input = {
    accounts: [{ id: 'A', limit: 100 }],
    batches: [B1, B2],
    transactions: [{ id: 'T1', account: 'A', amount: 10, windows: [] }],
  };
  const out = buildPlan(input);
  assert.equal(out.status, 'UNSAT');
});
