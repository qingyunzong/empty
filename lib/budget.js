'use strict';

const { ERR, ReconError } = require('./errors');

function usageOf(budgets, customerId, date) {
  const perCustomer = budgets.usage[customerId];
  if (!perCustomer) return 0;
  return perCustomer[date] || 0;
}

function limitOf(budgets, customerId, date) {
  const perCustomer = budgets.limits[customerId];
  if (!perCustomer || perCustomer[date] === undefined) return Infinity;
  return perCustomer[date];
}

function assertDelta(budgets, customerId, date, delta) {
  const net = usageOf(budgets, customerId, date) + delta;
  const limit = limitOf(budgets, customerId, date);
  if (net > limit || net < 0) {
    throw new ReconError(
      ERR.BUDGET_EXCEEDED,
      `budget violation for ${customerId} on ${date}: net=${net} limit=${limit === Infinity ? 'unlimited' : limit}`
    );
  }
  return net;
}

function applyDelta(budgets, customerId, date, delta) {
  const net = assertDelta(budgets, customerId, date, delta);
  if (!budgets.usage[customerId]) budgets.usage[customerId] = {};
  budgets.usage[customerId][date] = net;
  return net;
}

function setLimit(budgets, customerId, date, limit) {
  if (!budgets.limits[customerId]) budgets.limits[customerId] = {};
  budgets.limits[customerId][date] = Number(limit);
}

function applyBatch(store, batchId, opts = {}) {
  const batch = store.batches.find((b) => b.batchId === batchId);
  if (!batch) throw new ReconError(2, `batch not found: ${batchId}`);
  if (batch.status !== 'active') {
    throw new ReconError(2, `batch ${batchId} is not active (status=${batch.status})`);
  }
  const opId = `op-apply-${batchId}`;
  let op = store.journal.ops.find((o) => o.id === opId);
  if (op && op.status === 'completed') return { applied: false, net: usageOf(store.budgets, batch.customerId, batch.date) };
  if (!op) {
    const net = applyDelta(store.budgets, batch.customerId, batch.date, batch.amount);
    store.saveBudgets();
    op = { id: opId, type: 'apply', status: 'budget_updated', applied: [batchId], rolledBack: [], adjustments: [] };
    store.journal.ops.push(op);
    store.saveJournal();
    if (opts.failAfter === 'budget') {
      const err = new Error('simulated crash after budget update');
      err.simulated = true;
      throw err;
    }
    return finalizeApply(store, op, batch, net);
  }
  return finalizeApply(store, op, batch, usageOf(store.budgets, batch.customerId, batch.date));
}

function finalizeApply(store, op, batch, net) {
  batch.budgetApplied = true;
  store.saveBatches();
  op.status = 'completed';
  store.saveJournal();
  return { applied: true, net };
}

module.exports = { usageOf, limitOf, assertDelta, applyDelta, setLimit, applyBatch };
