'use strict';

const { plan } = require('./solve');

function createState(model) {
  return {
    model,
    journal: [],
    frozen: new Map(),
    txs: new Map(model.transactions.map((t) => [t.id, { ...t, status: 'PENDING', attempts: [] }])),
    plan: [],
    appliedCancellations: new Set(),
    conflict: null,
    nextBatchIndex: 0,
  };
}

function log(state, event) {
  state.journal.push({ seq: state.journal.length, ...event });
}

const frozenKey = (account, batch) => JSON.stringify([account, batch]);

function frozenAmount(state, account, batch) {
  return state.frozen.get(frozenKey(account, batch)) || 0;
}

// --- two-phase attempt primitives (the crash point lives between them) ---

function beginAttempt(state, txId, batch) {
  const tx = state.txs.get(txId);
  const attemptNo = tx.attempts.length + 1;
  tx.status = 'RUNNING';
  const attempt = { batch, attempt: attemptNo, result: null, freezeCommitted: false };
  tx.attempts.push(attempt);
  log(state, { type: 'begin', tx: txId, batch, attempt: attemptNo });
  return attempt;
}

function commitFreeze(state, txId, batch) {
  const tx = state.txs.get(txId);
  const limit = state.model.accounts.get(tx.account).limit;
  const used = frozenAmount(state, tx.account, batch);
  if (used + tx.amount > limit) {
    log(state, { type: 'freeze-rejected', tx: txId, batch, amount: tx.amount });
    return false;
  }
  state.frozen.set(frozenKey(tx.account, batch), used + tx.amount);
  log(state, { type: 'freeze', tx: txId, batch, amount: tx.amount });
  return true;
}

function unfreeze(state, tx, batch, reason) {
  state.frozen.set(frozenKey(tx.account, batch), frozenAmount(state, tx.account, batch) - tx.amount);
  log(state, { type: 'unfreeze', tx: tx.id, batch, amount: tx.amount, reason });
}

// --- planning ---

function replan(state, fromBatchIndex) {
  const futureBatches = state.model.batches.slice(fromBatchIndex).map((b) => b.id);
  const future = new Set(futureBatches);
  for (const item of state.plan) {
    if (item.status === 'scheduled' && future.has(item.batch)) item.status = 'removed';
  }
  const pending = [...state.txs.values()]
    .filter((t) => t.status === 'PENDING')
    .map((t) => ({ ...t, domain: t.domain.filter((b) => future.has(b)) }));
  if (pending.length === 0) return true;
  const capacityOf = (account, batch) =>
    state.model.accounts.get(account).limit - frozenAmount(state, account, batch);
  const result = plan(pending, futureBatches, capacityOf);
  if (!result.ok) {
    state.conflict = result.conflict;
    for (const tx of pending) {
      state.txs.get(tx.id).status = 'UNSAT';
      log(state, { type: 'unsat', tx: tx.id });
    }
    return false;
  }
  for (const tx of pending) {
    state.plan.push({ tx: tx.id, batch: result.assignment.get(tx.id), status: 'scheduled' });
  }
  return true;
}

// --- cancellation: first drop not-yet-started batches, then the running one ---

function removeFutureAttempts(state, txId, fromBatchIndex) {
  const future = new Set(state.model.batches.slice(fromBatchIndex).map((b) => b.id));
  for (const item of state.plan) {
    if (item.status === 'scheduled' && item.tx === txId && future.has(item.batch)) {
      item.status = 'removed';
      log(state, { type: 'attempt-removed', tx: txId, batch: item.batch });
    }
  }
}

function applyCancellations(state, batchIndex, phase) {
  const batchId = state.model.batches[batchIndex].id;
  for (const c of state.model.cancellations) {
    if (c.atBatch !== batchId || c.phase !== phase || state.appliedCancellations.has(c)) continue;
    state.appliedCancellations.add(c);
    const tx = state.txs.get(c.tx);
    if (tx.status === 'SUCCESS' || tx.status === 'CANCELLED' || tx.status === 'UNSAT') {
      log(state, { type: 'cancel-ignored', tx: tx.id, reason: tx.status });
      continue;
    }
    removeFutureAttempts(state, tx.id, batchIndex);
    if (tx.status === 'RUNNING') {
      const attempt = tx.attempts[tx.attempts.length - 1];
      if (attempt && attempt.freezeCommitted) unfreeze(state, tx, attempt.batch, 'cancel');
      if (attempt) attempt.result = 'CANCELLED';
    }
    tx.status = 'CANCELLED';
    log(state, { type: 'cancelled', tx: tx.id, phase });
  }
}

// --- execution ---

function executeAttempt(state, item, batchIndex) {
  const tx = state.txs.get(item.tx);
  const batch = item.batch;
  const attempt = beginAttempt(state, tx.id, batch);
  // crash point: status is RUNNING here but the freeze record is not committed
  if (!commitFreeze(state, tx.id, batch)) {
    attempt.result = 'FAILED_CAPACITY';
    tx.status = 'PENDING';
    item.status = 'done';
    return;
  }
  attempt.freezeCommitted = true;

  if (state.model.cancellations.some((c) =>
    c.tx === tx.id && c.atBatch === batch && c.phase === 'during' && !state.appliedCancellations.has(c))) {
    applyCancellations(state, batchIndex, 'during');
    item.status = 'done';
    return;
  }

  if (tx.failures.includes(batch)) {
    unfreeze(state, tx, batch, 'failed');
    attempt.result = 'FAILED';
    tx.status = 'PENDING';
    log(state, { type: 'failed', tx: tx.id, batch });
  } else {
    attempt.result = 'SUCCESS';
    tx.status = 'SUCCESS';
    log(state, { type: 'success', tx: tx.id, batch });
  }
  item.status = 'done';
}

function run(model, options = {}) {
  const state = options.state || createState(model);
  const startIndex = options.state ? state.nextBatchIndex : 0;
  replan(state, startIndex);
  const batches = state.model.batches;
  for (let i = startIndex; i < batches.length; i++) {
    state.nextBatchIndex = i;
    const batch = batches[i];
    log(state, { type: 'batch-start', batch: batch.id });
    applyCancellations(state, i, 'before');
    const scheduled = state.plan
      .filter((p) => p.status === 'scheduled' && p.batch === batch.id)
      .sort((a, b) => (a.tx < b.tx ? -1 : a.tx > b.tx ? 1 : 0));
    for (const item of scheduled) {
      if (state.txs.get(item.tx).status !== 'PENDING') { item.status = 'done'; continue; }
      executeAttempt(state, item, i);
    }
    if (i + 1 < batches.length) replan(state, i + 1);
    log(state, { type: 'batch-end', batch: batch.id });
    state.nextBatchIndex = i + 1;
  }
  return finish(state);
}

function finish(state) {
  const transactions = [...state.txs.values()].map((tx) => ({
    id: tx.id,
    account: tx.account,
    amount: tx.amount,
    status: tx.status,
    attempts: tx.attempts,
  }));
  const anyUnsat = transactions.some((t) => t.status === 'UNSAT');
  const allDone = transactions.every((t) => t.status === 'SUCCESS' || t.status === 'CANCELLED');
  const output = {
    status: anyUnsat ? 'UNSAT' : allDone ? 'OK' : 'PARTIAL',
    transactions,
    plan: state.plan.map((p) => ({ ...p })),
    journal: state.journal.map((e) => ({ ...e })),
  };
  if (state.conflict) output.conflict = state.conflict;
  return output;
}

// --- crash recovery: rebuild from the committed journal only ---

function recover(model, journal) {
  const state = createState(model);
  const batchOrder = model.batches.map((b) => b.id);
  for (const ev of journal) {
    const tx = ev.tx ? state.txs.get(ev.tx) : null;
    switch (ev.type) {
      case 'batch-end':
        state.nextBatchIndex = batchOrder.indexOf(ev.batch) + 1;
        break;
      case 'begin':
        tx.status = 'RUNNING';
        tx.attempts.push({ batch: ev.batch, attempt: ev.attempt, result: null, freezeCommitted: false });
        break;
      case 'freeze':
        tx.attempts[tx.attempts.length - 1].freezeCommitted = true;
        state.frozen.set(frozenKey(tx.account, ev.batch), frozenAmount(state, tx.account, ev.batch) + ev.amount);
        break;
      case 'unfreeze':
        state.frozen.set(frozenKey(tx.account, ev.batch), frozenAmount(state, tx.account, ev.batch) - ev.amount);
        break;
      case 'freeze-rejected':
        tx.status = 'PENDING';
        tx.attempts[tx.attempts.length - 1].result = 'FAILED_CAPACITY';
        break;
      case 'failed':
        tx.status = 'PENDING';
        tx.attempts[tx.attempts.length - 1].result = 'FAILED';
        break;
      case 'success':
        tx.status = 'SUCCESS';
        tx.attempts[tx.attempts.length - 1].result = 'SUCCESS';
        break;
      case 'cancelled': {
        tx.status = 'CANCELLED';
        const a = tx.attempts[tx.attempts.length - 1];
        if (a && a.result === null) a.result = 'CANCELLED';
        break;
      }
      case 'unsat':
        tx.status = 'UNSAT';
        break;
      default:
        break;
    }
  }
  // Any attempt left RUNNING at the crash point never completed its commit;
  // roll it back to PENDING so it can be safely retried. Never fake success.
  for (const tx of state.txs.values()) {
    if (tx.status !== 'RUNNING') continue;
    const last = tx.attempts[tx.attempts.length - 1];
    if (last && last.freezeCommitted) unfreeze(state, tx, last.batch, 'recovery');
    if (last) last.result = 'RECOVERED';
    tx.status = 'PENDING';
    log(state, { type: 'recovered', tx: tx.id, from: 'RUNNING', to: 'PENDING' });
  }
  return state;
}

module.exports = { createState, run, recover, beginAttempt, commitFreeze, replan, frozenAmount };
