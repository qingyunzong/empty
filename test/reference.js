'use strict';

// Reference scheduler for cross-checking: exhaustively enumerates every
// subset of "insert maintenance before order i" positions, simulates each
// candidate with the same placement primitives, keeps feasible plans
// (cycle life never exceeded), and picks the plan with the fewest
// maintenances, then earliest final completion.
const { placeOrder, placeMaintenance, parsedResets, parseTime } = require('../src/model');

function simulate(mold, orders, mask) {
  const resets = parsedResets(mold);
  let pointer = mold.startTime != null ? parseTime(mold.startTime) : 0;
  let used = mold.usedMinutes || 0;
  const maintenances = [];
  for (let i = 0; i < orders.length; i++) {
    if (mask & (1 << i)) {
      const [ms, me] = placeMaintenance(mold, pointer, maintenances, resets);
      maintenances.push([ms, me]);
      pointer = me;
      used = 0;
    }
    if (used + orders[i].minutes > mold.cycleMinutes) return null; // infeasible
    const placement = placeOrder(mold, pointer, orders[i].minutes, resets);
    pointer = placement.end;
    used += orders[i].minutes;
  }
  return { count: maintenances.length, completion: pointer, maintenances };
}

function bruteForceBest(mold, orders) {
  let best = null;
  const n = orders.length;
  for (let mask = 0; mask < (1 << n); mask++) {
    const plan = simulate(mold, orders, mask);
    if (!plan) continue;
    if (!best || plan.count < best.count ||
        (plan.count === best.count && plan.completion < best.completion)) {
      best = plan;
    }
  }
  return best;
}

module.exports = { bruteForceBest };
