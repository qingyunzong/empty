'use strict';

// Backtracking CSP solver for authorization placement.
//
// Variables: authorization requests (index 0 is the primary request, the
// rest are waiting orders retried alongside it). Domain: preset approval
// tiers (fractions of the requested amount, descending) plus 0 (left
// waiting). Constraints are propagated as remaining-capacity checks on the
// shared limit and each card limit; every trial assignment counts one
// search node against the budget.
//
// Result status:
//   SOLVED  - enumeration finished, primary request placed at some tier > 0
//   UNSAT   - enumeration finished, no tier > 0 fits the primary request
//   PENDING - node budget exhausted before enumeration completed

function solvePlacement({ variables, tiers, sharedRemaining, cardRemaining, budget }) {
  const domain = [...tiers, 0];
  const amounts = variables.map((v) => domain.map((t) => Math.floor(v.amount * t + 1e-9)));
  const n = variables.length;
  const assign = new Array(n).fill(-1);
  const cardUsed = new Map();
  let sharedUsed = 0;
  let nodes = 0;
  let exhausted = false;
  let optimal = false;
  let best = null;

  function score() {
    let placed = 0;
    let total = amounts[0][assign[0]];
    for (let i = 1; i < n; i += 1) {
      if (domain[assign[i]] > 0) placed += 1;
      total += amounts[i][assign[i]];
    }
    return { primaryTier: assign[0], placed, total, assign: assign.slice() };
  }

  function isBetter(candidate, current) {
    if (current === null) return true;
    if (candidate.primaryTier !== current.primaryTier) {
      return candidate.primaryTier < current.primaryTier;
    }
    if (candidate.placed !== current.placed) return candidate.placed > current.placed;
    return candidate.total > current.total;
  }

  function recurse(i) {
    if (exhausted || optimal) return;
    if (i === n) {
      const candidate = score();
      if (isBetter(candidate, best)) best = candidate;
      if (assign.every((a) => a === 0)) optimal = true;
      return;
    }
    const v = variables[i];
    for (let d = 0; d < domain.length; d += 1) {
      if (exhausted || optimal) break;
      nodes += 1;
      if (nodes > budget) {
        exhausted = true;
        return;
      }
      assign[i] = d;
      const amt = amounts[i][d];
      if (amt === 0) {
        recurse(i + 1);
        continue;
      }
      // propagation: prune against remaining shared and card capacity
      const cardRem = (cardRemaining.get(v.card) ?? 0) - (cardUsed.get(v.card) ?? 0);
      const sharedRem = sharedRemaining - sharedUsed;
      if (amt <= cardRem && amt <= sharedRem) {
        sharedUsed += amt;
        cardUsed.set(v.card, (cardUsed.get(v.card) ?? 0) + amt);
        recurse(i + 1);
        sharedUsed -= amt;
        cardUsed.set(v.card, (cardUsed.get(v.card) ?? 0) - amt);
      }
    }
    assign[i] = -1;
  }

  recurse(0);

  if (exhausted) return { status: 'PENDING', nodes, approved: new Map() };
  const approved = new Map();
  for (let i = 0; i < n; i += 1) {
    const amt = amounts[i][best.assign[i]];
    if (amt > 0) approved.set(variables[i].id, amt);
  }
  if (amounts[0][best.assign[0]] === 0) return { status: 'UNSAT', nodes, approved };
  return { status: 'SOLVED', nodes, approved };
}

module.exports = { solvePlacement };
