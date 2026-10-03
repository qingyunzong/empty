'use strict';

const { ERR, ReconError } = require('./errors');
const budget = require('./budget');

function detectCycle(batches) {
  const parentOf = new Map(batches.map((b) => [b.batchId, b.parentId || null]));
  for (const b of batches) {
    const seen = new Set();
    let cur = b.batchId;
    while (cur !== null && parentOf.has(cur)) {
      if (seen.has(cur)) {
        throw new ReconError(ERR.CYCLE, `cyclic dependency detected at batch ${cur}`);
      }
      seen.add(cur);
      cur = parentOf.get(cur);
    }
  }
}

function dependencyClosure(batches, rootId) {
  detectCycle(batches);
  const childrenOf = new Map();
  for (const b of batches) {
    if (b.parentId) {
      if (!childrenOf.has(b.parentId)) childrenOf.set(b.parentId, []);
      childrenOf.get(b.parentId).push(b.batchId);
    }
  }
  const out = [];
  const seen = new Set([rootId]);
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop();
    out.push(id);
    for (const child of childrenOf.get(id) || []) {
      if (!seen.has(child)) {
        seen.add(child);
        stack.push(child);
      }
    }
  }
  return out.sort();
}

function bruteForceClosure(batches, rootId) {
  const set = new Set([rootId]);
  let changed = true;
  let guard = 0;
  while (changed && guard <= batches.length + 1) {
    guard++;
    changed = false;
    for (const b of batches) {
      if (b.parentId && set.has(b.parentId) && !set.has(b.batchId)) {
        set.add(b.batchId);
        changed = true;
      }
    }
  }
  return [...set].sort();
}

function assertNoOrphanReceipts(store) {
  const known = new Set(store.batches.map((b) => b.batchId));
  for (const r of store.receipts) {
    if (r.batchId && !known.has(r.batchId)) {
      throw new ReconError(ERR.ORPHAN_RECEIPT, `orphan receipt ${r.receiptId} references unknown batch ${r.batchId}`);
    }
  }
}

function planRollback(store, batchId) {
  const byId = new Map(store.batches.map((b) => [b.batchId, b]));
  const closure = dependencyClosure(store.batches, batchId);
  const confirmedByReceipt = new Set(
    store.receipts.filter((r) => String(r.confirmed) === 'true').map((r) => r.batchId)
  );
  const ordered = closure
    .map((id) => byId.get(id))
    .sort((a, b) => b.layer - a.layer || (a.batchId < b.batchId ? -1 : 1));
  const rolledBack = [];
  const adjustments = [];
  const deltas = new Map();
  const addDelta = (b, delta) => {
    const key = `${b.customerId}|${b.date}`;
    deltas.set(key, (deltas.get(key) || 0) + delta);
  };
  for (const b of ordered) {
    if (b.status === 'rolled_back') continue;
    const confirmed = b.layer === 3 && (b.status === 'confirmed' || confirmedByReceipt.has(b.batchId));
    if (confirmed) {
      const adjId = `ADJ-${b.batchId}`;
      if (!byId.has(adjId)) {
        adjustments.push({
          batchId: adjId,
          parentId: b.batchId,
          layer: 3,
          customerId: b.customerId,
          amount: -b.amount,
          currency: b.currency,
          date: b.date,
          status: 'active',
          budgetApplied: false,
          kind: 'reversal',
        });
        if (b.budgetApplied) addDelta(b, -b.amount);
      }
    } else {
      rolledBack.push(b.batchId);
      if (b.budgetApplied) addDelta(b, -b.amount);
    }
  }
  return { rolledBack, adjustments, deltas };
}

function rollbackBatch(store, batchId, opts = {}) {
  const byId = new Map(store.batches.map((b) => [b.batchId, b]));
  if (!byId.has(batchId)) throw new ReconError(2, `batch not found: ${batchId}`);
  detectCycle(store.batches);
  assertNoOrphanReceipts(store);

  const opId = `op-rollback-${batchId}`;
  let op = store.journal.ops.find((o) => o.id === opId);
  if (op && op.status === 'completed') {
    return { rolledBack: op.rolledBack, adjustments: op.adjustments, resumed: false };
  }

  if (!op) {
    const plan = planRollback(store, batchId);
    for (const [key, delta] of plan.deltas) {
      const [customerId, date] = key.split('|');
      budget.assertDelta(store.budgets, customerId, date, delta);
    }
    for (const [key, delta] of plan.deltas) {
      const [customerId, date] = key.split('|');
      budget.applyDelta(store.budgets, customerId, date, delta);
    }
    store.saveBudgets();
    op = {
      id: opId,
      type: 'rollback',
      status: 'budget_updated',
      rolledBack: plan.rolledBack,
      adjustments: plan.adjustments,
      applied: [],
    };
    store.journal.ops.push(op);
    store.saveJournal();
    if (opts.failAfter === 'budget') {
      const err = new Error('simulated crash after budget update');
      err.simulated = true;
      throw err;
    }
  }

  for (const id of op.rolledBack) {
    const b = byId.get(id);
    if (b) b.status = 'rolled_back';
  }
  for (const adj of op.adjustments) {
    if (!byId.has(adj.batchId)) {
      store.batches.push(adj);
      byId.set(adj.batchId, adj);
    }
  }
  store.saveBatches();
  op.status = 'completed';
  store.saveJournal();
  return { rolledBack: op.rolledBack, adjustments: op.adjustments, resumed: true };
}

module.exports = { rollbackBatch, dependencyClosure, bruteForceClosure, detectCycle, planRollback };
