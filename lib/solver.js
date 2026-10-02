'use strict';

const CORE_CHECK_BUDGET = 5_000_000;

// Backtracking search with bound propagation.
// centers: [{ id, domain: number[] }] (domains sorted ascending, ratios in percent)
// Returns { status: 'FEASIBLE'|'UNSAT'|'PENDING', assignment, nodes }.
// PENDING means the node budget was exhausted before the search space was
// exhausted, so infeasibility was NOT proven.
function solve(centers, targetSum, budget) {
  const n = centers.length;
  const assignment = new Array(n).fill(null);
  const assigned = new Array(n).fill(false);
  let nodes = 0;
  let pending = false;

  function remainderFeasible(sumSoFar) {
    let lo = sumSoFar;
    let hi = sumSoFar;
    for (let i = 0; i < n; i++) {
      if (assigned[i]) continue;
      const domain = centers[i].domain;
      if (domain.length === 0) return false;
      lo += domain[0];
      hi += domain[domain.length - 1];
    }
    return lo <= targetSum && targetSum <= hi;
  }

  function backtrack(sumSoFar, remaining) {
    if (remaining === 0) return sumSoFar === targetSum;
    let pick = -1;
    for (let i = 0; i < n; i++) {
      if (assigned[i]) continue;
      if (pick === -1 || centers[i].domain.length < centers[pick].domain.length) pick = i;
    }
    if (centers[pick].domain.length === 0) return false;
    assigned[pick] = true;
    for (const value of centers[pick].domain) {
      nodes += 1;
      if (nodes > budget) {
        pending = true;
        assigned[pick] = false;
        assignment[pick] = null;
        return false;
      }
      assignment[pick] = value;
      if (remainderFeasible(sumSoFar + value) && backtrack(sumSoFar + value, remaining - 1)) {
        return true;
      }
      if (pending) {
        assigned[pick] = false;
        assignment[pick] = null;
        return false;
      }
    }
    assigned[pick] = false;
    assignment[pick] = null;
    return false;
  }

  if (!remainderFeasible(0)) return { status: 'UNSAT', assignment: null, nodes };
  if (backtrack(0, n)) return { status: 'FEASIBLE', assignment, nodes };
  return { status: pending ? 'PENDING' : 'UNSAT', assignment: null, nodes };
}

// Minimal (subset-minimal) set of cost centers whose tier/cap constraints
// already make the instance infeasible. Centers outside the set are relaxed
// to "any ratio 0..100", so the returned set is a genuine explanation.
// centers: [{ id, domain }]; locks: Map id -> fixed ratio.
function minimalConflict(centers, locks = new Map()) {
  const freeDomain = [];
  for (let v = 0; v <= 100; v++) freeDomain.push(v);
  const feasible = (keep) => {
    const sub = centers.map((c) => {
      if (!keep.has(c.id)) return { id: c.id, domain: freeDomain };
      return { id: c.id, domain: locks.has(c.id) ? [locks.get(c.id)] : c.domain };
    });
    return solve(sub, 100, CORE_CHECK_BUDGET).status === 'FEASIBLE';
  };
  const keep = new Set(centers.map((c) => c.id));
  if (feasible(keep)) return null;
  for (const c of centers) {
    keep.delete(c.id);
    if (feasible(keep)) keep.add(c.id);
  }
  return [...keep].sort();
}

module.exports = { solve, minimalConflict };
