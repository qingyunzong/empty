'use strict';

const solver = require('./solver');
const sm = require('./state');

// Apply cancellations to an existing batch plan.
// Ordering rule: first cancel retries in batches that have not started
// (delete them outright), then handle retries in running batches
// (mark CANCELLED, release tentative freeze).
function applyCancellations(planBatches, cancellations, batchStatus) {
  const cancelled = new Set(cancellations);
  const removed = [];
  const marked = [];

  // Phase 1: not-started batches — delete future retries of cancelled txs.
  for (const batch of planBatches) {
    if ((batchStatus.get(batch.batch) || 'pending') === 'running') continue;
    const keep = [];
    for (const retry of batch.retries) {
      if (cancelled.has(retry.tx)) {
        removed.push({ tx: retry.tx, batch: batch.batch });
      } else {
        keep.push(retry);
      }
    }
    batch.retries = keep;
  }
  // Phase 2: running batches — mark retries CANCELLED instead of deleting.
  for (const batch of planBatches) {
    if ((batchStatus.get(batch.batch) || 'pending') !== 'running') continue;
    for (const retry of batch.retries) {
      if (cancelled.has(retry.tx) && retry.state !== 'CANCELLED') {
        retry.state = 'CANCELLED';
        retry.freezeCommitted = false;
        marked.push({ tx: retry.tx, batch: batch.batch });
      }
    }
  }
  return { removed, marked };
}

function buildPlan(input) {
  const { accounts, batches, transactions } = input;
  const cancellations = input.cancellations || [];
  const cancelled = new Set(cancellations);
  const batchStatus = new Map(batches.map((b) => [b.id, b.status || 'pending']));

  // 1. Crash recovery first: RUNNING-without-committed-freeze -> PENDING.
  const recovered = input.state ? sm.recover(input.state) : [];

  // 2. Success permanence: succeeded transactions are never retried again.
  const succeeded = new Set();
  if (input.state) {
    for (const r of Object.values(input.state.retries)) {
      if (r.state === 'SUCCESS') succeeded.add(r.txId);
    }
  }

  // 3. Cancelled transactions are excluded from all future batches.
  const active = transactions.filter((t) => !cancelled.has(t.id) && !succeeded.has(t.id));

  const result = solver.plan(active, batches, accounts);
  const output = {
    status: result.sat ? 'SAT' : 'UNSAT',
    recovered: recovered.map((r) => ({ tx: r.txId, batch: r.batchId, state: r.state })),
    cancelled: Array.from(cancelled),
    skippedSucceeded: Array.from(succeeded),
  };

  if (!result.sat) {
    output.conflict = result.conflict; // minimal account-batch set
    return output;
  }

  // 4. Emit batch plan ordered by batch start time.
  const byBatch = new Map(batches.map((b) => [b.id, []]));
  for (const tx of active) {
    byBatch.get(result.assignment.get(tx.id)).push(tx);
  }
  const ordered = batches.slice().sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  output.plan = ordered.map((b) => {
    const txs = byBatch.get(b.id) || [];
    const frozen = {};
    for (const tx of txs) {
      frozen[tx.account] = (frozen[tx.account] || 0) + tx.amount;
    }
    return {
      batch: b.id,
      start: b.start,
      end: b.end,
      status: batchStatus.get(b.id),
      retries: txs.map((tx) => ({
        tx: tx.id,
        account: tx.account,
        amount: tx.amount,
        state: 'PENDING',
      })),
      frozenByAccount: frozen,
    };
  });
  return output;
}

module.exports = { buildPlan, applyCancellations };
