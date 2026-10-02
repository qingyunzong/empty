'use strict';
const { compareCanonical } = require('./canonical');
const { validatePlan, aggregatePlan } = require('./model');

// Exhaustively enumerate all feasible plan assignments for a small set of
// orders (<= 3) via DFS with budget pruning. An assignment schedules every
// given order with exactly one of its candidate plans; it is feasible iff
// the summed amounts per (material, day) never exceed the budgets.
function enumerateFeasibleAssignments(orders, budgets) {
  const limits = new Map();
  for (const b of budgets) limits.set(`${b.material}|${b.day}`, b.limit);
  const normalized = orders.map((o) => ({
    id: o.id,
    plans: o.plans.map(validatePlan).sort(compareCanonical),
  }));
  const results = [];
  const usage = new Map();
  const picked = [];
  function dfs(i) {
    if (i === normalized.length) {
      results.push(picked.map((p) => ({ orderId: p.orderId, plan: p.plan })));
      return;
    }
    const order = normalized[i];
    for (const plan of order.plans) {
      const agg = aggregatePlan(plan);
      let fits = true;
      for (const [key, amount] of agg) {
        const limit = limits.get(key) ?? 0;
        if ((usage.get(key) ?? 0) + amount > limit) {
          fits = false;
          break;
        }
      }
      if (!fits) continue;
      for (const [key, amount] of agg) usage.set(key, (usage.get(key) ?? 0) + amount);
      picked.push({ orderId: order.id, plan });
      dfs(i + 1);
      picked.pop();
      for (const [key, amount] of agg) usage.set(key, usage.get(key) - amount);
    }
  }
  dfs(0);
  results.sort(compareCanonical);
  return results;
}

// Deterministic optimum: lexicographically smallest canonical JSON.
function selectOptimalAssignment(assignments) {
  if (assignments.length === 0) return null;
  let best = assignments[0];
  for (const a of assignments) {
    if (compareCanonical(a, best) < 0) best = a;
  }
  return best;
}

module.exports = { enumerateFeasibleAssignments, selectOptimalAssignment };
