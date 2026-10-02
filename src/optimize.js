// Rework authorization: choose a subset of rework-eligible defects maximizing
// total net recovered value (amount - rework cost), subject to the shift budget
// and per-sku stock caps. Ties are broken deterministically by the
// lexicographically smallest sorted id tuple, so equal-value optima always
// resolve the same way.

export function compareIdSets(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

function isBetter(net, ids, best) {
  if (net !== best.net) return net > best.net;
  return compareIdSets(ids, best.ids) < 0;
}

function feasible(item, budgetLeft, stockLeft) {
  return item.cost <= budgetLeft && (stockLeft.get(item.sku) ?? 0) > 0;
}

// Exact branch-and-bound solver (production path).
export function selectRework(candidates, { budget, stockBySku }) {
  const items = [...candidates].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const n = items.length;
  const suffixPositive = new Array(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    suffixPositive[i] = suffixPositive[i + 1] + Math.max(0, items[i].net);
  }
  const stockLeft = new Map(stockBySku);
  const best = { net: 0, ids: [] };
  const ids = [];

  function dfs(i, budgetLeft, net) {
    if (isBetter(net, ids, best)) {
      best.net = net;
      best.ids = [...ids];
    }
    if (i === n) return;
    if (net + suffixPositive[i] < best.net) return; // cannot reach the best net
    const item = items[i];
    if (feasible(item, budgetLeft, stockLeft)) {
      stockLeft.set(item.sku, stockLeft.get(item.sku) - 1);
      ids.push(item.id);
      dfs(i + 1, budgetLeft - item.cost, net + item.net);
      ids.pop();
      stockLeft.set(item.sku, stockLeft.get(item.sku) + 1);
    }
    dfs(i + 1, budgetLeft, net);
  }

  dfs(0, budget, 0);
  return best.ids;
}

// Naive exhaustive subset loop (reference implementation used by tests to
// cross-check the exact solver on batches of <= 20 defects).
export function selectReworkNaive(candidates, { budget, stockBySku }) {
  const items = [...candidates].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const n = items.length;
  if (n > 30) throw new Error('naive solver refuses n > 30');
  const best = { net: 0, ids: [] };
  const total = 2 ** n;
  for (let mask = 0; mask < total; mask += 1) {
    let cost = 0;
    let net = 0;
    const ids = [];
    const used = new Map();
    let ok = true;
    for (let i = 0; i < n; i += 1) {
      if ((mask & (1 << i)) === 0) continue;
      const item = items[i];
      cost += item.cost;
      if (cost > budget) { ok = false; break; }
      const count = (used.get(item.sku) ?? 0) + 1;
      if (count > (stockBySku.get(item.sku) ?? 0)) { ok = false; break; }
      used.set(item.sku, count);
      net += item.net;
      ids.push(item.id);
    }
    if (ok && isBetter(net, ids, best)) {
      best.net = net;
      best.ids = ids;
    }
  }
  return best.ids;
}
