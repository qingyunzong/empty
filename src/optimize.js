const EPS = 1e-9;
const MAX_EXHAUSTIVE_COMBOS = 2_000_000;
const MAX_EXHAUSTIVE_COMBOS_SMALL_W = 100_000_000;
const SMALL_W = 3;
const MAX_SUBSET_LOADS = 20;
const MAX_PLANS = 1024;

function cmpLoads(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

function cmpPlans(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = cmpLoads(a[i].loads, b[i].loads);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

function subsetOptions(loads, budget) {
  const n = loads.length;
  const opts = [];
  const total = 1 << n;
  for (let mask = 0; mask < total; mask++) {
    let kw = 0;
    const picks = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        kw += loads[i].kw;
        picks.push(loads[i].load);
      }
    }
    if (kw <= budget + EPS) opts.push({ kw, loads: picks });
  }
  opts.sort((a, b) => a.kw - b.kw || cmpLoads(a.loads, b.loads));
  return opts;
}

function prefixOptions(loads, budget) {
  const sorted = [...loads].sort((a, b) => b.kw - a.kw || (a.load < b.load ? -1 : 1));
  const opts = [{ kw: 0, loads: [] }];
  let kw = 0;
  const picks = [];
  for (const l of sorted) {
    if (kw + l.kw > budget + EPS) continue;
    kw += l.kw;
    picks.push(l.load);
    opts.push({ kw, loads: [...picks].sort() });
  }
  opts.sort((a, b) => a.kw - b.kw || cmpLoads(a.loads, b.loads));
  return opts;
}

function exhaustive(windows, perWindow) {
  const W = windows.length;
  let bestCost = Infinity;
  let bestShed = Infinity;
  let plans = [];
  let truncated = false;
  const chosen = new Array(W);

  function snapshot() {
    return chosen.map((o, i) => ({ windowStart: windows[i].windowStart, kw: o.kw, loads: [...o.loads] }));
  }

  function recurse(d, shedSum, costSoFar) {
    if (costSoFar > bestCost + EPS) return;
    if (costSoFar >= bestCost - EPS && shedSum > bestShed + EPS) return;
    if (d === W) {
      const isBetter =
        costSoFar < bestCost - EPS ||
        (Math.abs(costSoFar - bestCost) <= EPS && shedSum < bestShed - EPS);
      const isTie =
        Math.abs(costSoFar - bestCost) <= EPS && Math.abs(shedSum - bestShed) <= EPS;
      if (isBetter) {
        bestCost = costSoFar;
        bestShed = shedSum;
        plans = [snapshot()];
        truncated = false;
      } else if (isTie) {
        if (plans.length < MAX_PLANS) {
          plans.push(snapshot());
        } else {
          truncated = true;
        }
      }
      return;
    }
    for (const opt of perWindow[d]) {
      chosen[d] = opt;
      const cost = (windows[d].baselineKw - opt.kw) * windows[d].rate;
      recurse(d + 1, shedSum + opt.kw, Math.max(costSoFar, cost));
    }
  }

  recurse(0, 0, 0);
  plans.sort(cmpPlans);
  return { method: 'exhaustive', cost: bestCost, totalShedKw: bestShed, plans, truncated };
}

function greedy(windows, perWindow) {
  const W = windows.length;
  const cur = new Array(W).fill(0);
  const costOf = () => {
    let c = 0;
    for (let i = 0; i < W; i++) {
      const v = (windows[i].baselineKw - perWindow[i][cur[i]].kw) * windows[i].rate;
      if (v > c) c = v;
    }
    return c;
  };

  for (let iter = 0; iter < 1000; iter++) {
    const c = costOf();
    let bestGain = EPS;
    let move = -1;
    for (let i = 0; i < W; i++) {
      if (cur[i] === perWindow[i].length - 1) continue;
      const v = (windows[i].baselineKw - perWindow[i][cur[i]].kw) * windows[i].rate;
      if (v < c - EPS) continue;
      const saved = cur[i];
      cur[i] = perWindow[i].length - 1;
      const c2 = costOf();
      cur[i] = saved;
      if (c - c2 > bestGain) {
        bestGain = c - c2;
        move = i;
      }
    }
    if (move < 0) break;
    cur[move] = perWindow[move].length - 1;
  }

  const target = costOf();
  for (let i = 0; i < W; i++) {
    for (let j = 0; j < cur[i]; j++) {
      const saved = cur[i];
      cur[i] = j;
      if (costOf() <= target + EPS) break;
      cur[i] = saved;
    }
  }

  let totalShedKw = 0;
  const plan = cur.map((idx, i) => {
    const o = perWindow[i][idx];
    totalShedKw += o.kw;
    return { windowStart: windows[i].windowStart, kw: o.kw, loads: [...o.loads] };
  });
  return { method: 'greedy', cost: costOf(), totalShedKw, plans: [plan], truncated: false };
}

// windows: [{ windowStart, baselineKw, rate }]  (baseline = metered demand + executed shed)
// loads:   [{ load, kw }] candidate sheddable loads, available in every window
// budget:  max sheddable kW per window
// Objective: minimize peak cost max_w (baseline_w - shed_w) * rate_w;
// ties: less total shed kW; remaining ties are all reported, load-lexicographic.
export function optimizeShed(windows, loads, budget = Infinity) {
  if (windows.length === 0) {
    return { method: 'exhaustive', cost: 0, totalShedKw: 0, plans: [[]], truncated: false };
  }
  const useSubsets = loads.length <= MAX_SUBSET_LOADS;
  const perWindow = windows.map(() => (useSubsets ? subsetOptions(loads, budget) : prefixOptions(loads, budget)));
  const combos = perWindow.reduce((acc, o) => acc * o.length, 1);
  const cap = windows.length <= SMALL_W ? MAX_EXHAUSTIVE_COMBOS_SMALL_W : MAX_EXHAUSTIVE_COMBOS;
  if (useSubsets && combos <= cap) {
    return exhaustive(windows, perWindow);
  }
  return greedy(windows, perWindow);
}
