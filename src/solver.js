const DAY_MS = 86_400_000;

export class BudgetExhausted extends Error {
  constructor() {
    super('search budget exhausted');
    this.name = 'BudgetExhausted';
  }
}

export function remainingDays(expiry, date) {
  return Math.floor((Date.parse(expiry) - Date.parse(date)) / DAY_MS);
}

function assertOrder(order) {
  if (!order || typeof order !== 'object') throw new TypeError('order must be an object');
  if (!Number.isInteger(order.quantity) || order.quantity <= 0) {
    throw new TypeError('order.quantity must be a positive integer');
  }
  if (typeof order.material !== 'string' || order.material.length === 0) {
    throw new TypeError('order.material is required');
  }
  if (typeof order.location !== 'string' || order.location.length === 0) {
    throw new TypeError('order.location is required');
  }
  if (Number.isNaN(Date.parse(order.date))) throw new TypeError('order.date must be an ISO date');
}

/**
 * Finite-domain batch allocation solver.
 *
 * Each candidate batch owns an integer allocation variable with domain
 * [0, min(available, demand)]. Bounds propagation prunes nodes whose
 * remaining upper-bound sum cannot cover the remaining demand; quality
 * status and expiry are propagated as unary domain restrictions.
 * Backtracking (branch & bound) minimizes total transfer cost, breaking
 * ties by minimizing the maximum remaining shelf life of used batches
 * (FEFO-consistent).
 */
export function solveAllocation(batches, order, { budget = 100_000 } = {}) {
  assertOrder(order);
  const demand = order.quantity;
  const transferCost = order.transferCostPerUnit ?? 0;

  const conflicts = [];
  const candidates = [];
  for (const batch of batches) {
    if (batch.material !== order.material) {
      conflicts.push({ batchId: batch.id, reason: 'material-mismatch', material: batch.material });
      continue;
    }
    if (batch.quality === 'quarantined') {
      conflicts.push({ batchId: batch.id, reason: 'quarantined' });
      continue;
    }
    const remaining = remainingDays(batch.expiry, order.date);
    if (remaining < 0) {
      conflicts.push({ batchId: batch.id, reason: 'expired', expiry: batch.expiry });
      continue;
    }
    const available = Math.max(0, Math.floor(batch.quantity));
    if (available === 0) {
      conflicts.push({ batchId: batch.id, reason: 'depleted' });
      continue;
    }
    candidates.push({
      id: batch.id,
      location: batch.location,
      expiry: batch.expiry,
      remaining,
      ub: Math.min(available, demand),
      costPerUnit: batch.location === order.location ? 0 : transferCost,
    });
  }

  // FEFO order: ascending remaining shelf life.
  candidates.sort((a, b) => a.remaining - b.remaining || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const n = candidates.length;
  const suffixUb = new Array(n + 1).fill(0);
  const suffixZeroUb = new Array(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    suffixUb[i] = suffixUb[i + 1] + candidates[i].ub;
    suffixZeroUb[i] = suffixZeroUb[i + 1] + (candidates[i].costPerUnit === 0 ? candidates[i].ub : 0);
  }

  if (suffixUb[0] < demand) {
    return {
      status: 'infeasible',
      conflicts: [...conflicts, { reason: 'insufficient-quantity', demand, available: suffixUb[0] }],
    };
  }

  const lowerBoundCost = (i, d) => {
    if (d <= 0) return 0;
    const fromFree = Math.min(d, suffixZeroUb[i]);
    return (d - fromFree) * transferCost;
  };

  const qtys = new Array(n).fill(0);
  let best = null;
  let nodes = 0;

  const isBetter = (cost, maxRemaining) =>
    best === null || cost < best.cost || (cost === best.cost && maxRemaining < best.maxRemaining);

  function dfs(i, remainingDemand, costSoFar, maxRemaining) {
    if (remainingDemand === 0) {
      if (isBetter(costSoFar, maxRemaining)) {
        best = { cost: costSoFar, maxRemaining, qtys: qtys.slice() };
      }
      return;
    }
    if (i === n) return;
    if (suffixUb[i] < remainingDemand) return; // bounds propagation
    if (best && costSoFar + lowerBoundCost(i, remainingDemand) > best.cost) return;
    nodes += 1;
    if (nodes > budget) throw new BudgetExhausted();

    const cand = candidates[i];
    const hi = Math.min(cand.ub, remainingDemand);
    const lo = Math.max(0, remainingDemand - suffixUb[i + 1]);
    for (let q = lo; q <= hi; q += 1) {
      qtys[i] = q;
      const nextCost = costSoFar + q * cand.costPerUnit;
      const nextMax = q > 0 ? Math.max(maxRemaining, cand.remaining) : maxRemaining;
      if (isBetter(nextCost, nextMax)) dfs(i + 1, remainingDemand - q, nextCost, nextMax);
    }
    qtys[i] = 0;
  }

  try {
    dfs(0, demand, 0, -1);
  } catch (err) {
    if (err instanceof BudgetExhausted) return { status: 'unknown', nodes };
    throw err;
  }

  if (!best) {
    return {
      status: 'infeasible',
      conflicts: [...conflicts, { reason: 'insufficient-quantity', demand, available: suffixUb[0] }],
    };
  }

  const allocation = [];
  for (let i = 0; i < n; i += 1) {
    if (best.qtys[i] > 0) {
      allocation.push({
        batchId: candidates[i].id,
        quantity: best.qtys[i],
        location: candidates[i].location,
        expiry: candidates[i].expiry,
        transferCost: best.qtys[i] * candidates[i].costPerUnit,
      });
    }
  }
  return {
    status: 'optimal',
    allocation,
    transferCost: best.cost,
    maxRemainingDays: best.maxRemaining,
    nodes,
  };
}
