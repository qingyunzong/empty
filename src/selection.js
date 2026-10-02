'use strict';

// Select the maximum-cardinality subset of candidate payments such that, per
// account, the sum of selected amounts does not exceed the available budget.
// Ties in cardinality are broken by choosing the lexicographically smallest
// sorted list of payment ids.
//
// candidates: [{ id, account, amount }]
// available:  { [account]: number }
// returns:    { selected: [id...], rejected: [id...] } (both sorted by id)
function selectMaxSet(candidates, available) {
  const sorted = [...candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const n = sorted.length;

  function feasible(combo) {
    const sums = new Map();
    for (const i of combo) {
      const c = sorted[i];
      sums.set(c.account, (sums.get(c.account) || 0) + c.amount);
    }
    for (const [account, sum] of sums) {
      if (sum > (available[account] ?? 0)) return false;
    }
    return true;
  }

  // Walk cardinalities from n downwards; combinations of a fixed size are
  // enumerated in lexicographic id order, so the first feasible combination
  // found is the lexicographically smallest maximum-cardinality set.
  for (let k = n; k >= 0; k -= 1) {
    const combo = [];
    let found = null;
    const visit = (start) => {
      if (found) return;
      if (combo.length === k) {
        if (feasible(combo)) found = combo.slice();
        return;
      }
      const remaining = k - combo.length;
      for (let i = start; i <= n - remaining; i += 1) {
        combo.push(i);
        visit(i + 1);
        combo.pop();
        if (found) return;
      }
    };
    visit(0);
    if (found) {
      const selected = found.map((i) => sorted[i].id);
      const chosen = new Set(selected);
      return {
        selected,
        rejected: sorted.filter((c) => !chosen.has(c.id)).map((c) => c.id),
      };
    }
  }
  return { selected: [], rejected: sorted.map((c) => c.id) };
}

module.exports = { selectMaxSet };
