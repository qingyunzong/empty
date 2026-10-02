import { solveAllocation } from './solver.js';

/**
 * Transactional order allocation. Pure: the input state is never mutated.
 * On any constraint failure (infeasible / unknown) the returned state is
 * the untouched input, so no partial reservation can leak into the store.
 */
export function allocateOrder(state, order, options = {}) {
  const result = solveAllocation(state.batches ?? [], order, options);
  if (result.status !== 'optimal') {
    return { ...result, state };
  }

  const taken = new Map(result.allocation.map((line) => [line.batchId, line.quantity]));
  const batches = state.batches.map((batch) => {
    const qty = taken.get(batch.id);
    return qty ? { ...batch, quantity: batch.quantity - qty } : { ...batch };
  });

  const nextState = {
    ...state,
    batches,
    orders: [...(state.orders ?? []), order],
    allocations: [
      ...(state.allocations ?? []),
      {
        orderId: order.id,
        lines: result.allocation,
        transferCost: result.transferCost,
        maxRemainingDays: result.maxRemainingDays,
      },
    ],
  };
  return { ...result, state: nextState };
}
