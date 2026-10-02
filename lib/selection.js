'use strict';

// Compare two ID lists (each sorted ascending) lexicographically.
function compareIdLists(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

// Exact batch selection.
//
// payments:   [{ id, account, amount }]
// capacities: Map account -> capacity, or plain object { account: capacity }
//
// Objective: maximize the number of selected payments such that, per account,
// the sum of selected amounts does not exceed the account capacity (every
// selected payment is settled in full). Among all maximum-cardinality sets,
// the lexicographically smallest sorted payment-ID list wins.
//
// Returns { selected: [id...] (sorted), rejected: [id...] (sorted) }.
function selectPayments(payments, capacities) {
  const cap = capacities instanceof Map ? capacities : new Map(Object.entries(capacities || {}));
  const items = payments
    .map((p) => ({ id: String(p.id), account: p.account, amount: p.amount }))
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const n = items.length;
  const sums = new Map();
  const chosen = [];
  let best = null;

  const isBetter = (candidate) => {
    if (best === null) return true;
    if (candidate.length !== best.length) return candidate.length > best.length;
    return compareIdLists(candidate, best) < 0;
  };

  // Depth-first include/exclude search over IDs in ascending order. Because
  // IDs are visited in order, `chosen` is always a sorted list.
  const dfs = (i) => {
    if (best !== null && chosen.length + (n - i) < best.length) return;
    if (i === n) {
      if (isBetter(chosen)) best = chosen.slice();
      return;
    }
    const it = items[i];
    const used = sums.get(it.account) || 0;
    const capacity = cap.has(it.account) ? cap.get(it.account) : 0;
    if (used + it.amount <= capacity) {
      sums.set(it.account, used + it.amount);
      chosen.push(it.id);
      dfs(i + 1);
      chosen.pop();
      sums.set(it.account, used);
    }
    dfs(i + 1);
  };
  dfs(0);

  const selected = best === null ? [] : best;
  const selectedSet = new Set(selected);
  const rejected = items.map((p) => p.id).filter((id) => !selectedSet.has(id));
  return { selected, rejected };
}

module.exports = { selectPayments, compareIdLists };
