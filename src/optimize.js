const EPS = 1e-9;

// Objective: minimize billing demand cost = max over windows of netKw * rate,
// where netKw = grossKw - shedKw and shedKw <= window budget (sum of load caps).
// Ties: minimize total shed kW, then allocate to loads in lexicographic order.
export function optimize(windows) {
  let target = 0;
  for (const w of windows) {
    const floor = Math.max(0, w.grossKw - w.shedKw) * w.rate;
    if (floor > target) target = floor;
  }
  const plan = [];
  let totalShedKw = 0;
  for (const w of windows) {
    let required = 0;
    if (w.rate > 0) {
      required = Math.max(0, w.grossKw - target / w.rate);
      required = Math.min(required, w.shedKw);
      if (required < EPS) required = 0;
    }
    let remaining = required;
    const loads = [...w.shed].sort((a, b) => (a.load < b.load ? -1 : a.load > b.load ? 1 : 0));
    for (const s of loads) { // lexicographic tie-break: fill smaller load names first
      if (remaining <= EPS) break;
      const take = Math.min(s.kw, remaining);
      if (take > EPS) {
        plan.push({ windowStart: w.windowStart, load: s.load, kw: take });
        remaining -= take;
        totalShedKw += take;
      }
    }
  }
  return { cost: target, totalShedKw, plan };
}

// Exhaustive check for small cases (<= 3 windows): enumerate per-window shed
// totals in `step` kW increments and find the best (cost, totalShed) pair.
export function bruteForce(windows, step = 1, maxCombinations = 2_000_000) {
  const grids = windows.map((w) => {
    const values = [];
    for (let v = 0; v < w.shedKw + EPS; v += step) values.push(Math.min(v, w.shedKw));
    if (values.length === 0 || values[values.length - 1] < w.shedKw - EPS) values.push(w.shedKw);
    return values;
  });
  let combinations = 1;
  for (const g of grids) combinations *= g.length;
  if (combinations > maxCombinations) {
    return { skipped: true, reason: `combinations ${combinations} exceed limit`, combinations };
  }
  let best = null;
  const choice = new Array(windows.length).fill(0);
  const visit = (i) => {
    if (i === windows.length) {
      let cost = 0;
      let total = 0;
      for (let k = 0; k < windows.length; k += 1) {
        const billed = Math.max(0, windows[k].grossKw - choice[k]) * windows[k].rate;
        if (billed > cost) cost = billed;
        total += choice[k];
      }
      if (!best || cost < best.cost - EPS ||
          (Math.abs(cost - best.cost) <= EPS && total < best.totalShedKw - EPS)) {
        best = { cost, totalShedKw: total };
      }
      return;
    }
    for (const v of grids[i]) {
      choice[i] = v;
      visit(i + 1);
    }
  };
  visit(0);
  return { skipped: false, combinations, ...best };
}
