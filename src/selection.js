export function netDeltas(transfers) {
  const deltas = {};
  for (const t of transfers) {
    deltas[t.from] = (deltas[t.from] ?? 0) + t.amount;
    deltas[t.to] = (deltas[t.to] ?? 0) - t.amount;
  }
  return deltas;
}

export function withinBudget(deltas, budgets, base = {}) {
  const parties = new Set([...Object.keys(deltas), ...Object.keys(base)]);
  for (const p of parties) {
    const limit = budgets[p];
    if (limit === undefined || limit === null) continue;
    if ((base[p] ?? 0) + (deltas[p] ?? 0) > limit) return false;
  }
  return true;
}

export function compareIdLists(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

function greedy(sorted, budgets, base) {
  const acc = {};
  const chosen = [];
  for (const t of sorted) {
    const trial = { ...acc };
    trial[t.from] = (trial[t.from] ?? 0) + t.amount;
    trial[t.to] = (trial[t.to] ?? 0) - t.amount;
    if (withinBudget(trial, budgets, base)) {
      Object.assign(acc, trial);
      chosen.push(t);
    }
  }
  return chosen;
}

export function selectSettleable(pending, budgets, base = {}) {
  const sorted = [...pending].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (sorted.length > 10) return greedy(sorted, budgets, base);
  const n = sorted.length;
  let bestIds = null;
  for (let mask = 0; mask < 1 << n; mask += 1) {
    const deltas = {};
    const ids = [];
    for (let i = 0; i < n; i += 1) {
      if (!(mask & (1 << i))) continue;
      const t = sorted[i];
      ids.push(t.id);
      deltas[t.from] = (deltas[t.from] ?? 0) + t.amount;
      deltas[t.to] = (deltas[t.to] ?? 0) - t.amount;
    }
    if (!withinBudget(deltas, budgets, base)) continue;
    if (
      bestIds === null ||
      ids.length > bestIds.length ||
      (ids.length === bestIds.length && compareIdLists(ids, bestIds) < 0)
    ) {
      bestIds = ids;
    }
  }
  const chosen = new Set(bestIds ?? []);
  return sorted.filter((t) => chosen.has(t.id));
}
