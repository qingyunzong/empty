import { enumerateCycles, totalAmount } from './graph.js';

export const MAX_SOLUTIONS = 1000;

function stateKey(edges) {
  return [...edges.entries()]
    .filter(([, a]) => a > 0n)
    .sort(([x], [y]) => (x < y ? -1 : 1))
    .map(([k, a]) => `${k}:${a}`)
    .join(';');
}

function applyCycle(edges, cycle) {
  const next = new Map(edges);
  for (const ek of cycle.edgeKeys) {
    next.set(ek, next.get(ek) - cycle.bottleneck);
  }
  return next;
}

// Solve one currency's directed debt graph.
// Returns {
//   minCash: BigInt            minimal residual settlement total (integer cents)
//   solutions: [[{key, members, amount}], ...]  all tied optima, deterministic order
//   truncated: bool
// }
export function solveGraph(edges, maxSolutions = MAX_SOLUTIONS) {
  const best = new Map(); // stateKey -> minimal reachable residual total (BigInt)
  const cyclesMemo = new Map(); // stateKey -> cycles of that state
  const cyclesOf = (st) => {
    const key = stateKey(st);
    let c = cyclesMemo.get(key);
    if (!c) cyclesMemo.set(key, (c = enumerateCycles(st)));
    return c;
  };

  const dfs = (st) => {
    const key = stateKey(st);
    const hit = best.get(key);
    if (hit !== undefined) return hit;
    const cycles = cyclesOf(st);
    let result;
    if (cycles.length === 0) {
      result = totalAmount(st);
    } else {
      result = null;
      for (const c of cycles) {
        const val = dfs(applyCycle(st, c));
        if (result === null || val < result) result = val;
      }
    }
    best.set(key, result);
    return result;
  };

  const minCash = dfs(edges);

  // Enumerate all canonical solutions (sorted cycle sets) attaining minCash.
  // solsOf(state) is path-independent, so memoize per state.
  const solsMemo = new Map(); // stateKey -> Map(signature -> canonical solution)
  let truncated = false;
  const solsOf = (st) => {
    const key = stateKey(st);
    const hit = solsMemo.get(key);
    if (hit) return hit;
    const out = new Map();
    const cycles = cyclesOf(st);
    if (cycles.length === 0) {
      out.set('', []);
    } else {
      const target = best.get(key);
      for (const c of cycles) {
        const next = applyCycle(st, c);
        if (best.get(stateKey(next)) !== target) continue;
        const step = { key: c.key, members: c.members, amount: c.bottleneck };
        for (const tail of solsOf(next).values()) {
          const sol = [...tail, step].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
          const sig = sol.map((s) => `${s.key}@${s.amount}`).join('|');
          if (!out.has(sig)) out.set(sig, sol);
        }
        if (out.size >= maxSolutions) { truncated = true; break; }
      }
    }
    solsMemo.set(key, out);
    return out;
  };

  const rootSols = solsOf(edges);
  if (rootSols.size >= maxSolutions) truncated = true;
  const solutions = [...rootSols.keys()].sort().map((sig) => rootSols.get(sig));
  return { minCash, solutions, truncated };
}

// Replay a solution's cycles on the initial graph to get the residual edges.
export function residualAfter(edges, solution) {
  let st = new Map(edges);
  for (const step of solution) {
    for (let i = 0; i < step.members.length; i++) {
      const from = step.members[i];
      const to = step.members[(i + 1) % step.members.length];
      const ek = `${from}>${to}`;
      st.set(ek, st.get(ek) - step.amount);
    }
  }
  return st;
}
