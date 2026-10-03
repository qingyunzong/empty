'use strict';

class BudgetExceeded extends Error {
  constructor() {
    super('node budget exhausted');
    this.code = 'BUDGET_EXCEEDED';
  }
}

// Candidate approval amounts for one request, descending.
// Full amount is always a candidate; preset tiers add partial amounts;
// 0 (decline) is appended unless the request is required.
function candidateAmounts(amount, tiers, required) {
  const set = new Set([amount]);
  for (const tier of tiers) {
    const value = Math.floor(amount * tier);
    if (value > 0 && value < amount) set.add(value);
  }
  const list = [...set].sort((a, b) => b - a);
  if (!required) list.push(0);
  return list;
}

// Depth-first search with propagation (capacity pruning) and backtracking.
// requests: [{ id, card, category, amount, required, layers: [layerKey...] }]
// limits/used: Map<layerKey, number>
// Returns { status: 'OK'|'UNSAT'|'PENDING', assignment, conflictLayers, nodes }.
function solve(requests, limits, used, tiers, budget) {
  const remaining = new Map();
  for (const [key, limit] of limits) {
    remaining.set(key, limit - (used.get(key) ?? 0));
  }

  // Root propagation: existing occupancy must not violate any layer.
  const violated = [...remaining.entries()]
    .filter(([, rem]) => rem < 0)
    .map(([key]) => key);
  if (violated.length > 0) {
    return { status: 'UNSAT', assignment: null, conflictLayers: violated, nodes: 0 };
  }

  const candidates = requests.map((r) => candidateAmounts(r.amount, tiers, r.required));
  const assignment = new Array(requests.length).fill(null);
  let nodes = 0;

  function fits(request, amount) {
    for (const layer of request.layers) {
      if (remaining.get(layer) < amount) return false;
    }
    return true;
  }

  function dfs(index) {
    if (index === requests.length) return true;
    const request = requests[index];
    for (const amount of candidates[index]) {
      nodes += 1;
      if (nodes > budget) throw new BudgetExceeded();
      if (!fits(request, amount)) continue; // propagation: prune infeasible tier
      for (const layer of request.layers) remaining.set(layer, remaining.get(layer) - amount);
      assignment[index] = amount;
      if (dfs(index + 1)) return true;
      for (const layer of request.layers) remaining.set(layer, remaining.get(layer) + amount);
      assignment[index] = null; // backtrack
    }
    return false;
  }

  try {
    if (dfs(0)) return { status: 'OK', assignment, conflictLayers: [], nodes };
    return { status: 'UNSAT', assignment: null, conflictLayers: [], nodes };
  } catch (err) {
    if (err instanceof BudgetExceeded) {
      return { status: 'PENDING', assignment: null, conflictLayers: [], nodes };
    }
    throw err;
  }
}

module.exports = { solve, candidateAmounts, BudgetExceeded };
