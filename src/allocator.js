'use strict';

const { solve } = require('./solver');
const { saveStateAtomic, PersistError } = require('./store');

/**
 * Apply an allocation plan to the in-memory state. Returns a rollback
 * function that restores the exact prior in-memory state.
 */
function applyAllocations(state, order, result) {
  const touched = [];
  for (const alloc of result.allocations) {
    const batch = state.batches.find((b) => b.id === alloc.batchId);
    batch.allocated = (batch.allocated || 0) + alloc.quantity;
    touched.push({ batch, quantity: alloc.quantity });
  }
  state.orders.push({
    ...order,
    status: 'allocated',
    allocations: result.allocations,
    transferCost: result.transferCost,
    maxRemainingShelfLifeDays: result.maxRemainingShelfLifeDays,
  });
  return function rollback() {
    for (const t of touched) t.batch.allocated -= t.quantity;
    state.orders.pop();
  };
}

/**
 * Allocate one order as a transaction: solve, apply to memory, persist
 * atomically. Any failure (infeasible, unknown, or persistence error)
 * leaves both the in-memory state and the on-disk state untouched.
 *
 * Returns { status, result, rolledBack }.
 */
function allocateOrder(state, order, options = {}) {
  const result = solve(state, order, options);
  if (result.status !== 'optimal') {
    return { status: result.status, result, rolledBack: false };
  }
  const rollback = applyAllocations(state, order, result);
  if (options.persist) {
    try {
      saveStateAtomic(options.stateFile, state, {
        failBeforeRename: options.failBeforeRename,
      });
    } catch (err) {
      if (err instanceof PersistError) {
        rollback();
        return { status: 'persist-failed', result: { error: err.message }, rolledBack: true };
      }
      throw err;
    }
  }
  return { status: 'optimal', result, rolledBack: false };
}

module.exports = { allocateOrder, applyAllocations };
