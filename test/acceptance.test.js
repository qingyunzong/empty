'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CancellationEngine } = require('../lib/engine');

function fourStageTx(overrides = {}) {
  return {
    id: 'tx1',
    stages: [
      { id: 'trade', type: 'trade', account: 'A', amount: 100 },
      { id: 'fee', type: 'fee', account: 'A', amount: 10, dependsOn: ['trade'] },
      { id: 'freeze', type: 'freeze', account: 'A', amount: 100, dependsOn: ['fee'] },
      { id: 'settle', type: 'settle', account: 'A', amount: 110, dependsOn: ['freeze'] },
    ].map((stage) => ({ ...stage, ...(overrides[stage.id] || {}) })),
  };
}

function allDomainBatch(quota) {
  return { id: 'b1', domains: ['trade', 'fee', 'freeze', 'settle'], quotas: { A: quota } };
}

test('acceptance 1: four stages compensate in exact reverse order', () => {
  const output = new CancellationEngine({
    transactions: [fourStageTx()],
    batches: [allDomainBatch(1000)],
    requests: [{ idempotencyKey: 'k1', transactionId: 'tx1' }],
  }).processAll();

  assert.equal(output.status, 'COMPLETED');
  const [result] = output.results;
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(
    result.sequence.map((r) => r.stageId),
    ['settle', 'freeze', 'fee', 'trade']
  );
  assert.deepEqual(
    result.sequence.map((r) => r.mode),
    ['delete', 'delete', 'delete', 'delete']
  );
  assert.deepEqual(
    output.state.sequence.map((r) => [r.seq, r.stageId, r.batchId]),
    [[1, 'settle', 'b1'], [2, 'freeze', 'b1'], [3, 'fee', 'b1'], [4, 'trade', 'b1']]
  );
  assert.deepEqual(output.state.pending, []);
  assert.deepEqual(output.state.remainingQuotas, { b1: { A: 1000 - 320 } });
});

test('acceptance 2: reconciled middle stage is red-flushed, not deleted', () => {
  const output = new CancellationEngine({
    transactions: [fourStageTx({ freeze: { status: 'reconciled' } })],
    batches: [allDomainBatch(1000)],
    requests: [{ idempotencyKey: 'k1', transactionId: 'tx1' }],
  }).processAll();

  assert.equal(output.status, 'COMPLETED');
  const modes = Object.fromEntries(
    output.results[0].sequence.map((r) => [r.stageId, r.mode])
  );
  assert.deepEqual(modes, {
    settle: 'delete',
    freeze: 'reversal',
    fee: 'delete',
    trade: 'delete',
  });
});

test('acceptance 3: insufficient quota yields partial success and recoverable pending', () => {
  const engine = new CancellationEngine({
    transactions: [fourStageTx()],
    batches: [allDomainBatch(150)],
    requests: [
      { idempotencyKey: 'k1', transactionId: 'tx1' },
      { idempotencyKey: 'k2', transactionId: 'tx1' },
    ],
  });
  const output = engine.processAll();

  assert.equal(output.status, 'PARTIAL');
  const [first, second] = output.results;

  // Quota 150 covers settle (110) only; freeze (100) no longer fits.
  assert.equal(first.status, 'PARTIAL');
  assert.deepEqual(first.sequence.map((r) => r.stageId), ['settle']);
  assert.deepEqual(
    first.pending.map((p) => p.stageId),
    ['freeze', 'fee', 'trade']
  );
  assert.ok(first.pending.every((p) => p.recoverable));

  // Conflict is rooted at freeze and propagates up to its parents.
  assert.equal(first.conflicts.length, 1);
  const conflict = first.conflicts[0];
  assert.equal(conflict.stageId, 'freeze');
  assert.equal(conflict.reason, 'INSUFFICIENT_QUOTA');
  assert.deepEqual(conflict.path, ['freeze', 'fee', 'trade']);
  assert.deepEqual(conflict.infeasibleBatches, [
    { batchId: 'b1', account: 'A', remaining: 40, required: 100 },
  ]);

  // Pending compensations survive and are retried by the next request.
  assert.equal(second.status, 'REJECTED');
  assert.deepEqual(
    second.pending.map((p) => p.stageId),
    ['freeze', 'fee', 'trade']
  );
  assert.deepEqual(
    output.state.pending.map((p) => p.stageId),
    ['freeze', 'fee', 'trade']
  );
  assert.deepEqual(output.state.remainingQuotas, { b1: { A: 40 } });
});

test('acceptance 4: repeated idempotency key replays the same result', () => {
  const output = new CancellationEngine({
    transactions: [fourStageTx()],
    batches: [allDomainBatch(1000)],
    requests: [
      { idempotencyKey: 'k1', transactionId: 'tx1' },
      { idempotencyKey: 'k1', transactionId: 'tx1' },
    ],
  }).processAll();

  assert.equal(output.status, 'COMPLETED');
  const [first, second] = output.results;
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  const strip = ({ replayed, ...rest }) => rest;
  assert.deepEqual(strip(second), strip(first));

  // Replay must not duplicate compensations or consume quota twice.
  assert.equal(output.state.sequence.length, 4);
  assert.deepEqual(output.state.remainingQuotas, { b1: { A: 680 } });
});

test('unknown transaction is rejected without failing the run', () => {
  const output = new CancellationEngine({
    transactions: [fourStageTx()],
    batches: [allDomainBatch(1000)],
    requests: [{ idempotencyKey: 'k1', transactionId: 'nope' }],
  }).processAll();
  assert.equal(output.status, 'REJECTED');
  assert.equal(output.results[0].status, 'REJECTED');
  assert.match(output.results[0].reason, /unknown transaction/);
});

test('batch domain restriction forces placement into allowed batches', () => {
  const output = new CancellationEngine({
    transactions: [
      {
        id: 'tx1',
        stages: [
          { id: 'trade', type: 'trade', account: 'A', amount: 100 },
          { id: 'fee', type: 'fee', account: 'A', amount: 10, dependsOn: ['trade'] },
        ],
      },
    ],
    batches: [
      { id: 'b-fee', domains: ['fee'], quotas: { A: 50 } },
      { id: 'b-trade', domains: ['trade'], quotas: { A: 500 } },
    ],
    requests: [{ idempotencyKey: 'k1', transactionId: 'tx1' }],
  }).processAll();

  assert.equal(output.status, 'COMPLETED');
  assert.deepEqual(
    output.results[0].sequence.map((r) => [r.stageId, r.batchId]),
    [['fee', 'b-fee'], ['trade', 'b-trade']]
  );
});

test('backtracking reorders batch choices to fit all stages', () => {
  // Greedy first-fit would put fee into b1 (60 left), leaving trade (100)
  // unplaceable in b1; backtracking moves fee to b2 so trade fits in b1.
  const output = new CancellationEngine({
    transactions: [
      {
        id: 'tx1',
        stages: [
          { id: 'trade', type: 'trade', account: 'A', amount: 100 },
          { id: 'fee', type: 'fee', account: 'A', amount: 40, dependsOn: ['trade'] },
        ],
      },
    ],
    batches: [
      { id: 'b1', domains: ['trade', 'fee'], quotas: { A: 100 } },
      { id: 'b2', domains: ['fee'], quotas: { A: 100 } },
    ],
    requests: [{ idempotencyKey: 'k1', transactionId: 'tx1' }],
  }).processAll();

  assert.equal(output.status, 'COMPLETED');
  assert.deepEqual(
    output.results[0].sequence.map((r) => [r.stageId, r.batchId]),
    [['fee', 'b2'], ['trade', 'b1']]
  );
});
