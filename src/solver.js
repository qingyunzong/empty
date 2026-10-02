'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(fromIso, toIso) {
  return Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / DAY_MS);
}

function availableOf(batch) {
  return batch.quantity - (batch.allocated || 0);
}

/**
 * Finite-domain filtering: decide, for every batch in state, whether it can
 * take part in satisfying `order`, and prune its domain accordingly.
 *
 * Domain pruning rules (propagation):
 *  - material must match the order's material;
 *  - quality status must not be quarantined (quality-status propagation);
 *  - remaining shelf life at the order date must satisfy the order's
 *    minimum remaining-shelf-life requirement (expired batches pruned);
 *  - batch must sit at the order location, or a transfer cost must be
 *    defined (order.transferCostPerUnit, else state.config.transferCostPerUnit)
 *    so the move can be paid for;
 *  - quantity domain of a surviving batch is [0, min(available, demand)].
 *
 * Returns { candidates, conflicts }. Each candidate:
 *   { batch, remainingDays, unitTransferCost, lo, hi }
 */
function filterCandidates(state, order) {
  const conflicts = [];
  const candidates = [];
  const minShelf = order.minRemainingShelfLifeDays || 0;
  const transferCostPerUnit =
    order.transferCostPerUnit !== undefined
      ? order.transferCostPerUnit
      : state.config && state.config.transferCostPerUnit;

  for (const batch of state.batches) {
    if (batch.material !== order.material) {
      conflicts.push({ batchId: batch.id, reason: 'material-mismatch' });
      continue;
    }
    if (batch.qualityStatus === 'quarantined') {
      conflicts.push({ batchId: batch.id, reason: 'quality-quarantined' });
      continue;
    }
    const remainingDays = daysBetween(order.date, batch.expiryDate);
    if (remainingDays < minShelf) {
      conflicts.push({
        batchId: batch.id,
        reason: 'expired-or-insufficient-shelf-life',
        remainingDays,
        requiredDays: minShelf,
      });
      continue;
    }
    const available = availableOf(batch);
    if (available <= 0) {
      conflicts.push({ batchId: batch.id, reason: 'no-available-quantity' });
      continue;
    }
    const sameLocation = batch.location === order.location;
    if (!sameLocation && transferCostPerUnit === undefined) {
      conflicts.push({
        batchId: batch.id,
        reason: 'location-mismatch-transfer-cost-undefined',
        batchLocation: batch.location,
        orderLocation: order.location,
      });
      continue;
    }
    candidates.push({
      batch,
      remainingDays,
      unitTransferCost: sameLocation ? 0 : transferCostPerUnit,
      lo: 0,
      hi: Math.min(available, order.quantity),
    });
  }
  return { candidates, conflicts };
}

/**
 * Solve the allocation as a finite-domain CSP with branch-and-bound.
 *
 * Variables: one integer variable per candidate batch, domain [lo, hi].
 * Constraint: sum of assigned quantities === order.quantity (exact demand,
 * propagated through lower/upper bounds: a batch's forced lower bound is
 * demand minus the sum of every other batch's upper bound).
 *
 * Objective (lexicographic):
 *   1. minimize total transfer cost;
 *   2. minimize the maximum remaining shelf life over used batches
 *      (near-expiry-first / FEFO as a tie-break).
 *
 * Search visits batches ordered by (unit transfer cost, remaining days),
 * taking as much as possible from the cheapest, earliest-expiring batch
 * first. `budget` caps the number of search nodes; exhausting it yields
 * status 'unknown'.
 */
function solve(state, order, options = {}) {
  const budget = options.budget !== undefined ? options.budget : 100000;
  const demand = order.quantity;
  const { candidates, conflicts } = filterCandidates(state, order);

  candidates.sort((a, b) =>
    a.unitTransferCost - b.unitTransferCost ||
    a.remainingDays - b.remainingDays ||
    (a.batch.id < b.batch.id ? -1 : 1)
  );

  const n = candidates.length;
  const sumHi = candidates.reduce((acc, c) => acc + c.hi, 0);
  if (sumHi < demand) {
    return {
      status: 'infeasible',
      conflicts: [
        ...conflicts,
        { reason: 'insufficient-quantity', demand, eligibleAvailable: sumHi },
      ],
    };
  }

  // Suffix sums of upper bounds, used to propagate forced lower bounds.
  const suffixHi = new Array(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) suffixHi[i] = suffixHi[i + 1] + candidates[i].hi;

  let nodes = 0;
  let exhausted = false;
  let best = null; // { cost, maxShelf, take: number[] }
  const take = new Array(n).fill(0);

  function dfs(i, remaining, cost, maxShelf) {
    if (exhausted) return;
    if (++nodes > budget) { exhausted = true; return; }
    if (best && (cost > best.cost || (cost === best.cost && maxShelf >= best.maxShelf))) return;
    if (remaining === 0) {
      best = { cost, maxShelf, take: take.slice() };
      return;
    }
    if (i === n) return;
    if (suffixHi[i] < remaining) return; // bound propagation: cannot reach demand

    const forced = Math.max(candidates[i].lo, remaining - suffixHi[i + 1]);
    const takeMax = Math.min(candidates[i].hi, remaining);
    if (forced > takeMax) return; // domain wipe-out

    for (let q = takeMax; q >= forced; q--) {
      take[i] = q;
      dfs(
        i + 1,
        remaining - q,
        cost + q * candidates[i].unitTransferCost,
        q > 0 ? Math.max(maxShelf, candidates[i].remainingDays) : maxShelf
      );
      if (exhausted) return;
    }
    take[i] = 0;
  }

  dfs(0, demand, 0, 0);

  if (exhausted) {
    return {
      status: 'unknown',
      reason: 'budget-exhausted',
      nodes,
      incumbent: best ? toAllocations(candidates, best) : null,
    };
  }
  if (!best) {
    return { status: 'infeasible', conflicts };
  }
  return { status: 'optimal', nodes, ...toAllocations(candidates, best) };
}

function toAllocations(candidates, best) {
  const allocations = [];
  for (let i = 0; i < candidates.length; i++) {
    if (best.take[i] > 0) {
      allocations.push({
        batchId: candidates[i].batch.id,
        location: candidates[i].batch.location,
        quantity: best.take[i],
        remainingDays: candidates[i].remainingDays,
        unitTransferCost: candidates[i].unitTransferCost,
      });
    }
  }
  return {
    allocations,
    transferCost: best.cost,
    maxRemainingShelfLifeDays: best.maxShelf,
  };
}

module.exports = { solve, filterCandidates, daysBetween, availableOf };
