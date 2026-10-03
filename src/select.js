// Exact top-k selection under a hard budget constraint, by enumerating
// all non-empty subsets of size <= k. Score is additive per job.
//
// Optimality: maximize total score; among max-score subsets minimize
// total cost (i.e. maximize remaining budget). Subsets still tied after
// that are ALL returned (never an arbitrary pick), each sorted by job id
// ascending and the list sorted lexicographically by id.
export function selectOptimal(items, k, budget) {
  const n = items.length;
  const limit = Math.min(k, n);
  let bestScore = -Infinity;
  let bestCost = Infinity;
  let masks = [];
  const total = 1 << n;
  for (let mask = 1; mask < total; mask++) {
    let count = 0;
    let cost = 0;
    let score = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        count++;
        cost += items[i].cost;
        score += items[i].score;
      }
    }
    if (count > limit || cost > budget) continue;
    if (score > bestScore || (score === bestScore && cost < bestCost)) {
      bestScore = score;
      bestCost = cost;
      masks = [mask];
    } else if (score === bestScore && cost === bestCost) {
      masks.push(mask);
    }
  }
  const optima = masks.map((mask) => {
    const ids = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) ids.push(items[i].id);
    ids.sort();
    return { ids, score: bestScore, cost: bestCost, remaining: budget - bestCost };
  });
  optima.sort((a, b) => {
    const len = Math.min(a.ids.length, b.ids.length);
    for (let i = 0; i < len; i++) {
      if (a.ids[i] < b.ids[i]) return -1;
      if (a.ids[i] > b.ids[i]) return 1;
    }
    return a.ids.length - b.ids.length;
  });
  return optima;
}
