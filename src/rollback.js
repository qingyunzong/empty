'use strict';

const { ReconError, ERR_CYCLE, ERR_ORPHAN } = require('./errors');
const { checkBudget, applyBudget } = require('./budget');

// Dependency closure of rootId: root plus all transitive child batches.
// Throws code=20 on any circular parent chain in the batch graph.
function dependencyClosure(batches, rootId) {
  const byId = new Map(batches.map((b) => [b.batchId, b]));
  for (const b of batches) {
    const seen = new Set([b.batchId]);
    let cur = b;
    while (cur.parentId != null) {
      const parent = byId.get(cur.parentId);
      if (!parent) break;
      if (seen.has(parent.batchId)) {
        throw new ReconError(ERR_CYCLE, `circular dependency detected at batch ${parent.batchId}`, {
          batchId: parent.batchId,
        });
      }
      seen.add(parent.batchId);
      cur = parent;
    }
  }
  const children = new Map();
  for (const b of batches) {
    if (b.parentId != null) {
      if (!children.has(b.parentId)) children.set(b.parentId, []);
      children.get(b.parentId).push(b);
    }
  }
  const root = byId.get(rootId);
  if (!root) throw new ReconError(1, `batch not found: ${rootId}`, { batchId: rootId });
  const closure = [];
  const seen = new Set([rootId]);
  const queue = [root];
  while (queue.length) {
    const node = queue.shift();
    closure.push(node);
    for (const child of children.get(node.batchId) || []) {
      if (!seen.has(child.batchId)) {
        seen.add(child.batchId);
        queue.push(child);
      }
    }
  }
  return closure;
}

// Roll back batchId and its dependent child batches, layered:
//  - bank-confirmed batches are never rolled back; a reversal adjustment is
//    generated instead and the original batch status stays untouched.
//  - budget is validated for the whole closure first (code=22 -> nothing changes).
// Crash safety: a journal records the phase. If the process dies after the
// budget update but before rollback markers are written, the next call resumes
// from the journal and never applies the budget twice.
function rollback(state, batchId, opts = {}) {
  const persist = opts.persist || (() => {});
  const opId = `rollback:${batchId}`;
  const byId = new Map(state.batches.map((b) => [b.batchId, b]));
  const target = byId.get(batchId);
  if (!target) throw new ReconError(1, `batch not found: ${batchId}`, { batchId });
  if (target.layer === 'bank' && (target.parentId == null || !byId.has(target.parentId))) {
    throw new ReconError(ERR_ORPHAN, `orphan bank receipt: ${batchId} has no parent clearing batch`, {
      batchId, parentId: target.parentId ?? null,
    });
  }
  if (state.journal && state.journal.opId === opId && state.journal.phase === 'done') {
    return { batchId, rolledBack: [], reversals: [], alreadyDone: true };
  }
  const resumed = !!(state.journal && state.journal.opId === opId && state.journal.phase === 'budget_applied');

  const closure = dependencyClosure(state.batches, batchId);
  const confirmedBank = closure.filter((b) => b.layer === 'bank' && b.bankConfirmed && b.status === 'active');
  const toRollback = closure.filter((b) => !(b.layer === 'bank' && b.bankConfirmed) && b.status === 'active');
  const affected = [...toRollback, ...confirmedBank];
  const deltas = affected.map((b) => ({ customerId: b.customerId, date: b.date, delta: -b.amount }));

  if (!resumed) {
    checkBudget(state, deltas); // code=22 -> throw before any mutation
    applyBudget(state, deltas);
    state.journal = { opId, phase: 'budget_applied' };
    persist(state);
    if (opts.crashAfterBudget) {
      const err = new Error('simulated crash after budget update');
      err.simulated = true;
      throw err;
    }
  }

  const rolledBack = [];
  for (const b of toRollback) {
    b.status = 'rolled_back';
    rolledBack.push(b.batchId);
  }
  const reversals = [];
  for (const b of confirmedBank) {
    const id = `ADJ-${b.batchId}`;
    if (!state.adjustments.some((a) => a.id === id)) {
      state.adjustments.push({
        id, type: 'reversal', ofBatchId: b.batchId, customerId: b.customerId,
        amount: -b.amount, currency: b.currency, date: b.date,
        createdAt: new Date().toISOString(),
      });
    }
    reversals.push(id); // original batch status deliberately untouched
  }
  state.journal = { opId, phase: 'done' };
  persist(state);
  return { batchId, rolledBack, reversals, resumed };
}

module.exports = { dependencyClosure, rollback };
