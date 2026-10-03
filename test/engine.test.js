'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runAll, compensationOrder } = require('../lib/engine');
const { chainTx, referenceAssignment, mulberry32 } = require('./helpers');

const ALL_KINDS = ['trade', 'fee', 'freeze', 'settlement'];

function batchAll(id, recoverable) {
  return { id, domains: [...ALL_KINDS], recoverable };
}

test('acceptance 1: four-stage chain compensates in exact reverse order', () => {
  const input = {
    transactions: [chainTx('tx1')],
    batches: [batchAll('b1', { A: 1000 })],
    requests: [{ idempotencyKey: 'k1', transactionId: 'tx1' }],
  };
  const { results, state } = runAll(input);
  assert.equal(results.length, 1);
  const result = results[0];
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.replayed, false);
  assert.deepEqual(
    result.sequence.map((entry) => entry.stageId),
    ['tx1-settlement', 'tx1-freeze', 'tx1-fee', 'tx1-trade'],
  );
  assert.deepEqual(
    result.sequence.map((entry) => entry.kind),
    ['settlement', 'freeze', 'fee', 'trade'],
  );
  assert.ok(result.sequence.every((entry) => entry.action === 'delete'));
  assert.ok(result.sequence.every((entry) => entry.batchId === 'b1'));
  assert.deepEqual(result.pending, []);
  assert.equal(result.conflictPath, null);
  assert.deepEqual(state.transactions[0].compensated, [
    'tx1-settlement',
    'tx1-freeze',
    'tx1-fee',
    'tx1-trade',
  ]);
});

test('acceptance 2: reconciled middle stage is red-flushed, not deleted', () => {
  const input = {
    transactions: [chainTx('tx2', { statuses: { freeze: 'reconciled' } })],
    batches: [batchAll('b1', { A: 1000 })],
    requests: [{ idempotencyKey: 'k1', transactionId: 'tx2' }],
  };
  const { results } = runAll(input);
  const result = results[0];
  assert.equal(result.status, 'COMPLETED');
  const byKind = new Map(result.sequence.map((entry) => [entry.kind, entry.action]));
  assert.equal(byKind.get('settlement'), 'delete');
  assert.equal(byKind.get('freeze'), 'reversal');
  assert.equal(byKind.get('fee'), 'delete');
  assert.equal(byKind.get('trade'), 'delete');
});

test('acceptance 3: insufficient quota yields PARTIAL and pending compensation is recoverable', () => {
  const input = {
    transactions: [chainTx('tx3')], // total 300, quota 250
    batches: [batchAll('b1', { A: 250 })],
    requests: [
      { idempotencyKey: 'k1', transactionId: 'tx3' },
      { idempotencyKey: 'k2', transactionId: 'tx3' },
    ],
  };
  const { results, state } = runAll(input);

  const first = results[0];
  assert.equal(first.status, 'PARTIAL');
  assert.deepEqual(
    first.sequence.map((entry) => entry.stageId),
    ['tx3-settlement', 'tx3-freeze', 'tx3-fee'],
  );
  assert.deepEqual(first.pending, ['tx3-trade']);
  assert.deepEqual(first.conflictPath, ['tx3-trade']);

  // The follow-up request resumes exactly the pending stage and completes.
  const second = results[1];
  assert.equal(second.status, 'COMPLETED');
  assert.deepEqual(
    second.sequence.map((entry) => entry.stageId),
    ['tx3-trade'],
  );
  assert.deepEqual(second.pending, []);
  assert.deepEqual(second.compensated, [
    'tx3-settlement',
    'tx3-freeze',
    'tx3-fee',
    'tx3-trade',
  ]);

  // Incrementally maintained state: each stage compensated exactly once.
  assert.deepEqual(state.transactions[0].compensated, [
    'tx3-settlement',
    'tx3-freeze',
    'tx3-fee',
    'tx3-trade',
  ]);
  assert.equal(state.transactions[0].sequence.length, 4);
});

test('acceptance 4: duplicate idempotency key replays the same result without side effects', () => {
  const input = {
    transactions: [chainTx('tx4')],
    batches: [batchAll('b1', { A: 1000 })],
    requests: [
      { idempotencyKey: 'k1', transactionId: 'tx4' },
      { idempotencyKey: 'k1', transactionId: 'tx4' },
      { idempotencyKey: 'k2', transactionId: 'tx4' },
    ],
  };
  const { results, state } = runAll(input);

  const [first, replay, after] = results;
  assert.equal(first.status, 'COMPLETED');
  assert.equal(first.replayed, false);

  assert.equal(replay.replayed, true);
  const strip = ({ replayed, ...rest }) => rest;
  assert.deepEqual(strip(replay), strip(first));

  // Replay did not re-apply anything: still exactly 4 compensated stages.
  assert.equal(state.transactions[0].sequence.length, 4);

  // A fresh key on a fully cancelled transaction is rejected.
  assert.equal(after.status, 'REJECTED');
  assert.equal(after.reason, 'NOTHING_TO_CANCEL');
});

test('unknown transaction is REJECTED', () => {
  const input = {
    transactions: [chainTx('tx5')],
    batches: [batchAll('b1', { A: 1000 })],
    requests: [{ idempotencyKey: 'k1', transactionId: 'missing' }],
  };
  const { results } = runAll(input);
  assert.equal(results[0].status, 'REJECTED');
  assert.equal(results[0].reason, 'TRANSACTION_NOT_FOUND');
});

test('backtracking finds a placement that greedy first-batch choice misses', () => {
  const input = {
    transactions: [chainTx('tx6')], // settle 100, freeze 100, fee 50, trade 50
    batches: [
      batchAll('b1', { A: 100 }),
      { id: 'b2', domains: ['freeze', 'settlement'], recoverable: { A: 200 } },
    ],
    requests: [{ idempotencyKey: 'k1', transactionId: 'tx6' }],
  };
  const { results } = runAll(input);
  const result = results[0];
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(
    result.sequence.map((entry) => [entry.stageId, entry.batchId]),
    [
      ['tx6-settlement', 'b2'],
      ['tx6-freeze', 'b2'],
      ['tx6-fee', 'b1'],
      ['tx6-trade', 'b1'],
    ],
  );
});

test('conflict path walks from the blocked stage up to the root', () => {
  const input = {
    transactions: [chainTx('tx7')],
    batches: [batchAll('b1', { A: 100 })], // only settlement fits
    requests: [{ idempotencyKey: 'k1', transactionId: 'tx7' }],
  };
  const { results } = runAll(input);
  const result = results[0];
  assert.equal(result.status, 'PARTIAL');
  assert.deepEqual(result.sequence.map((entry) => entry.stageId), ['tx7-settlement']);
  assert.deepEqual(result.pending, ['tx7-freeze', 'tx7-fee', 'tx7-trade']);
  assert.deepEqual(result.conflictPath, ['tx7-freeze', 'tx7-fee', 'tx7-trade']);
});

test('domain mismatch alone can make a sequence infeasible', () => {
  const input = {
    transactions: [chainTx('tx8')],
    batches: [{ id: 'b1', domains: ['settlement', 'freeze'], recoverable: { A: 1000 } }],
    requests: [{ idempotencyKey: 'k1', transactionId: 'tx8' }],
  };
  const { results } = runAll(input);
  const result = results[0];
  assert.equal(result.status, 'PARTIAL');
  assert.deepEqual(result.sequence.map((entry) => entry.stageId), ['tx8-settlement', 'tx8-freeze']);
  assert.deepEqual(result.pending, ['tx8-fee', 'tx8-trade']);
});

test('quota is enforced per account independently', () => {
  const input = {
    transactions: [chainTx('tx9', { account: 'A' }), chainTx('tx10', { account: 'B' })],
    batches: [batchAll('b1', { A: 300, B: 100 })],
    requests: [
      { idempotencyKey: 'k1', transactionId: 'tx9' },
      { idempotencyKey: 'k2', transactionId: 'tx10' },
    ],
  };
  const { results } = runAll(input);
  assert.equal(results[0].status, 'COMPLETED'); // A: 300 <= 300
  assert.equal(results[1].status, 'PARTIAL'); // B: 300 > 100
});

test('cross-check engine against <=4-stage batch enumeration reference', () => {
  const random = mulberry32(20261003);
  const pick = (arr) => arr[Math.floor(random() * arr.length)];
  const kinds = [...ALL_KINDS];
  const accounts = ['A', 'B'];

  for (let iteration = 0; iteration < 300; iteration += 1) {
    const stageCount = 1 + Math.floor(random() * 4);
    const stages = [];
    for (let i = 0; i < stageCount; i += 1) {
      const dependsOn = [];
      for (let j = i + 1; j < stageCount; j += 1) {
        if (random() < 0.4) dependsOn.push(`s${j}`);
      }
      stages.push({
        id: `s${i}`,
        kind: pick(kinds),
        account: pick(accounts),
        amount: (1 + Math.floor(random() * 10)) * 10,
        status: random() < 0.25 ? 'reconciled' : 'posted',
        dependsOn,
      });
    }
    const batchCount = 1 + Math.floor(random() * 3);
    const batches = [];
    for (let i = 0; i < batchCount; i += 1) {
      const domains = kinds.filter(() => random() < 0.6);
      if (domains.length === 0) domains.push(pick(kinds));
      const recoverable = {};
      for (const account of accounts) {
        if (random() < 0.8) recoverable[account] = Math.floor(random() * 25) * 10;
      }
      batches.push({ id: `b${i}`, domains, recoverable });
    }

    const input = {
      transactions: [{ id: 'tx', stages }],
      batches,
      requests: [{ idempotencyKey: 'k', transactionId: 'tx' }],
    };
    const { results } = runAll(input);
    const result = results[0];

    // Reference check on the engine's compensation order.
    const tx = { stages: new Map(stages.map((s) => [s.id, s])) };
    const order = compensationOrder(tx);
    const reference = referenceAssignment(order, batches);

    assert.equal(
      result.status === 'COMPLETED',
      reference !== null,
      `iteration ${iteration}: engine=${result.status} reference=${reference ? 'feasible' : 'infeasible'}`,
    );
    if (result.status === 'COMPLETED') {
      // Verify the engine's placement satisfies every constraint.
      const usage = new Map();
      for (const entry of result.sequence) {
        const batch = batches.find((b) => b.id === entry.batchId);
        assert.ok(batch.domains.includes(entry.kind), `iteration ${iteration}: domain`);
        const key = `${entry.batchId}${entry.account}`;
        const total = (usage.get(key) || 0) + entry.amount;
        usage.set(key, total);
        const quota = batch.recoverable[entry.account] ?? 0;
        assert.ok(total <= quota, `iteration ${iteration}: quota`);
      }
    } else {
      // PARTIAL: pending stages must be exactly the uncompensated suffix.
      assert.ok(result.pending.length > 0);
      assert.equal(result.sequence.length + result.pending.length, stageCount);
    }
  }
});
