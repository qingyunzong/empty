'use strict';

const { reservedCents, tierRate } = require('./money');

const DEFAULT_BACKTRACK_BUDGET = 100000;
const MAX_CONFLICTS = 100;

class BudgetExhausted extends Error {}

// Tiers ordered by preference: reserve as much as possible.
function orderedTiers(tiers) {
  return [...tiers].sort((a, b) => tierRate(b) - tierRate(a));
}

function buildGroups(docs) {
  const byKey = new Map();
  for (const d of docs) {
    const key = d.group !== undefined ? `group:${d.group}` : `doc:${d.id}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(d);
  }
  const groups = [];
  for (const members of byKey.values()) {
    const minDemand = Object.create(null);
    const maxDemand = Object.create(null);
    for (const d of members) {
      const amounts = d.tiers.map((t) => reservedCents(d.cents, t));
      const lo = Math.min(...amounts);
      const hi = Math.max(...amounts);
      minDemand[d.category] = (minDemand[d.category] ?? 0) + lo;
      maxDemand[d.category] = (maxDemand[d.category] ?? 0) + hi;
    }
    groups.push({ members, minDemand, maxDemand });
  }
  const total = (dem) => Object.values(dem).reduce((a, b) => a + b, 0);
  // Deterministic order: largest maximum demand first (fail fast on big groups).
  groups.sort((a, b) => total(b.maxDemand) - total(a.maxDemand));
  return groups;
}

// Branch-and-bound over a finite-domain CSP:
//   - one package variable per related-document group (same group, same package)
//   - one tier variable per document
// Objective: maximize total reserved cents. Propagation prunes packages that
// cannot hold a group's minimum demand and tiers that exceed the remaining
// per-category capacity. Every undo consumes the backtrack budget; exhausting
// it aborts the search with status PENDING.
//
// packages: [{id, limits: {category: cents}}]
// docs: [{id, category, cents, tiers: [...], group?: string}]
// preUsed: {packageId: {category: cents}} capacity already held (red-flush holds)
function solve({ packages, docs, budget, preUsed = {} }) {
  const backtrackBudget = budget === undefined ? DEFAULT_BACKTRACK_BUDGET : budget;

  const used = packages.map((p) => {
    const m = Object.create(null);
    const pre = preUsed[p.id] ?? {};
    for (const [cat, v] of Object.entries(pre)) m[cat] = v;
    return m;
  });

  const conflicts = [];
  const conflictKeys = new Set();
  let backtracks = 0;

  function addConflict(conflict) {
    const key = JSON.stringify(conflict);
    if (!conflictKeys.has(key) && conflicts.length < MAX_CONFLICTS) {
      conflictKeys.add(key);
      conflicts.push(conflict);
    }
  }

  function remaining(pkgIdx, cat) {
    const limit = packages[pkgIdx].limits[cat] ?? 0;
    return limit - (used[pkgIdx][cat] ?? 0);
  }

  function spendBacktrack() {
    backtracks += 1;
    if (backtracks > backtrackBudget) throw new BudgetExhausted();
  }

  const groups = buildGroups(docs);
  // suffixMax[i] = sum of maximum reservable cents over groups i..end, used
  // as an optimistic bound for branch-and-bound pruning.
  const suffixMax = new Array(groups.length + 1).fill(0);
  for (let i = groups.length - 1; i >= 0; i--) {
    suffixMax[i] = suffixMax[i + 1] + Object.values(groups[i].maxDemand).reduce((a, b) => a + b, 0);
  }

  const assignment = new Map(); // docId -> {pkgIdx, tier}
  let currentTotal = 0;
  let bestTotal = -1;
  let bestAssignment = null;

  function minDemandBlocker(group, pkgIdx) {
    for (const [cat, need] of Object.entries(group.minDemand)) {
      if (need > remaining(pkgIdx, cat)) {
        return { category: cat, needed: need, available: remaining(pkgIdx, cat) };
      }
    }
    return null;
  }

  function searchGroup(gi) {
    if (gi === groups.length) {
      if (currentTotal > bestTotal) {
        bestTotal = currentTotal;
        bestAssignment = new Map(assignment);
      }
      return;
    }
    if (currentTotal + suffixMax[gi] <= bestTotal) return; // cannot beat incumbent
    const group = groups[gi];
    for (let p = 0; p < packages.length; p++) {
      const blocker = minDemandBlocker(group, p);
      if (blocker) {
        addConflict({
          type: 'capacity',
          package: packages[p].id,
          category: blocker.category,
          docs: group.members.map((m) => m.id),
          needed: blocker.needed,
          available: blocker.available,
        });
        continue;
      }
      searchTiers(group, gi, p, 0);
    }
  }

  function searchTiers(group, gi, pkgIdx, di) {
    if (di === group.members.length) {
      searchGroup(gi + 1);
      return;
    }
    const d = group.members[di];
    for (const tier of orderedTiers(d.tiers)) {
      const amt = reservedCents(d.cents, tier);
      if (amt > remaining(pkgIdx, d.category)) {
        addConflict({
          type: 'capacity',
          package: packages[pkgIdx].id,
          category: d.category,
          doc: d.id,
          needed: amt,
          available: remaining(pkgIdx, d.category),
        });
        continue;
      }
      used[pkgIdx][d.category] = (used[pkgIdx][d.category] ?? 0) + amt;
      assignment.set(d.id, { pkgIdx, tier });
      currentTotal += amt;
      searchTiers(group, gi, pkgIdx, di + 1);
      currentTotal -= amt;
      assignment.delete(d.id);
      used[pkgIdx][d.category] -= amt;
      spendBacktrack();
    }
  }

  let exhausted = false;
  try {
    searchGroup(0);
  } catch (e) {
    if (e instanceof BudgetExhausted) {
      exhausted = true;
    } else {
      throw e;
    }
  }

  let status;
  if (exhausted) {
    status = 'PENDING';
  } else if (bestAssignment === null) {
    status = 'UNSAT';
  } else {
    status = 'OK';
  }

  if (status === 'UNSAT') {
    // Aggregate explanation: categories whose minimum total demand exceeds
    // the total capacity across all packages can never be satisfied.
    const minByCat = Object.create(null);
    for (const d of docs) {
      const lo = Math.min(...d.tiers.map((t) => reservedCents(d.cents, t)));
      minByCat[d.category] = (minByCat[d.category] ?? 0) + lo;
    }
    const capByCat = Object.create(null);
    for (let p = 0; p < packages.length; p++) {
      for (const [cat, limit] of Object.entries(packages[p].limits)) {
        const held = preUsed[packages[p].id]?.[cat] ?? 0;
        capByCat[cat] = (capByCat[cat] ?? 0) + Math.max(0, limit - held);
      }
    }
    for (const [cat, need] of Object.entries(minByCat)) {
      const cap = capByCat[cat] ?? 0;
      if (need > cap) {
        addConflict({ type: 'category-capacity', category: cat, required: need, capacity: cap });
      }
    }
  }

  // For PENDING, return the incumbent (best assignment seen so far), if any.
  const assignments =
    bestAssignment === null
      ? []
      : docs.map((d) => {
          const a = bestAssignment.get(d.id);
          return {
            id: d.id,
            packageId: packages[a.pkgIdx].id,
            tier: a.tier,
            reservedCents: reservedCents(d.cents, a.tier),
          };
        });

  return { status, assignments, conflicts, backtracks, backtrackBudget };
}

module.exports = { solve, buildGroups };
