import { ACTIVE, ancestorsOf, closureOf } from './state.js';

// Total price of a rollback set: sum of costs over the ACTIVE nodes in its
// closure. Shared nodes are charged once (closure is a Set); nodes that are
// already rolled back are never charged again.
export function planCost(state, ids) {
  let total = 0;
  for (const id of closureOf(state, ids)) {
    const node = state.nodes.get(id);
    if (node.status === ACTIVE) total += node.cost;
  }
  return total;
}

// Ancestor/descendant constraint: a set "covers" the target when the target
// lies in the set's rollback closure, i.e. some selected node is the target
// itself or one of its ancestors (rolling back a node cascades to all of its
// active descendants).
export function coversTarget(state, ids, target) {
  return closureOf(state, ids).has(target);
}

// A feasible rollback set is an inclusion-minimal set that covers the target:
// removing any member would leave the target un-rolled-back.
export function isMinimalCovering(state, ids, target) {
  if (ids.length === 0 || !coversTarget(state, ids, target)) return false;
  for (const id of ids) {
    if (coversTarget(state, ids.filter((other) => other !== id), target)) return false;
  }
  return true;
}

// Tie-break key: node paths sorted lexicographically, then concatenated.
export function concatKey(state, ids) {
  return ids.map((id) => state.nodes.get(id).path).sort().join('');
}

// Execution order: all active nodes in the closure, deepest first (a node's
// active descendants are always rolled back before the node itself), ties by
// path for determinism.
export function executionOrder(state, ids) {
  return [...closureOf(state, ids)]
    .filter((id) => state.nodes.get(id).status === ACTIVE)
    .sort((a, b) => {
      const na = state.nodes.get(a);
      const nb = state.nodes.get(b);
      if (na.depth !== nb.depth) return nb.depth - na.depth;
      return na.path < nb.path ? -1 : na.path > nb.path ? 1 : 0;
    });
}

// Select the minimum-cost feasible rollback set for `target` within `budget`.
//
// Minimal covering sets are exactly the singletons {a} where a is the target
// or one of its ancestors: a single ancestor's closure already contains the
// target, and any set with two or more nodes can drop one and still cover.
// Among the sets whose cost fits the budget we take the minimum cost; ties
// are broken by the lexicographically smallest concatenation of node paths.
export function selectPlan(state, target, budget) {
  if (!state.nodes.has(target)) throw new Error(`unknown node: "${target}"`);
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget < 0) {
    throw new Error('budget must be a non-negative finite number');
  }
  const candidates = [target, ...ancestorsOf(state, target)].map((id) => [id]);
  const evaluated = candidates.map((ids) => ({
    ids,
    cost: planCost(state, ids),
    key: concatKey(state, ids),
  }));

  let requiredCost = Infinity;
  for (const entry of evaluated) requiredCost = Math.min(requiredCost, entry.cost);

  const withinBudget = evaluated.filter((entry) => entry.cost <= budget);
  if (withinBudget.length === 0) {
    return { feasible: false, target, budget, requiredCost };
  }

  let bestCost = Infinity;
  for (const entry of withinBudget) bestCost = Math.min(bestCost, entry.cost);
  const winners = withinBudget
    .filter((entry) => entry.cost === bestCost)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const best = winners[0];

  return {
    feasible: true,
    target,
    budget,
    cost: best.cost,
    nodes: [...best.ids],
    paths: best.ids.map((id) => state.nodes.get(id).path),
    affected: executionOrder(state, best.ids),
    tiedSets: winners.length > 1 ? winners.map((entry) => [...entry.ids]) : [],
  };
}
