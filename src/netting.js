import { NetError, E } from './errors.js';

// Canonical cycle: node sequence rotated so the lexicographically smallest
// member id comes first. Rotation-equivalent cycles share one canonical key.
export function canonCycle(nodes) {
  let k = 0;
  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i] < nodes[k]) k = i;
  }
  return nodes.slice(k).concat(nodes.slice(0, k));
}

export const cycleKey = (nodes) => canonCycle(nodes).join('→');

// All simple directed cycles, each reported once in canonical form.
// `adj`: Map member -> sorted array of successors (only live edges).
export function enumerateCycles(members, adj) {
  const sorted = [...members].sort();
  const found = new Map();
  for (const s of sorted) {
    const path = [s];
    const onPath = new Set([s]);
    const dfs = (u) => {
      for (const v of adj.get(u) || []) {
        if (v === s) {
          if (path.length >= 2) found.set(path.join('→'), [...path]);
        } else if (v > s && !onPath.has(v)) {
          onPath.add(v);
          path.push(v);
          dfs(v);
          path.pop();
          onPath.delete(v);
        }
      }
    };
    dfs(s);
  }
  return [...found.values()];
}

export function assertUniqueCycles(cycles) {
  const seen = new Set();
  for (const c of cycles) {
    if (seen.has(c.key)) {
      throw new NetError(E.CYCLE_DUP, `duplicate canonical cycle ${c.key} in one solution`);
    }
    seen.add(c.key);
  }
}

// Netting semantics: a solution cancels simple cycles at their bottleneck
// amount (integer cents, never fractional). Cancelling a cycle preserves
// every member's net position. The optimum minimises residual gross, i.e.
// the cash that must actually move. All tied optima are enumerated.
export function optimize(graph) {
  const members = [...graph.members].sort();
  const edgeList = [...graph.edges.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const edgeIndex = new Map(edgeList.map(([k], i) => [k, i]));
  const st0 = edgeList.map(([, e]) => e.amount);
  const sum = (st) => st.reduce((a, b) => a + b, 0);

  // All simple cycles of the full graph, computed once; a cycle live in any
  // residual state is a cycle of the original graph.
  const adj0 = new Map(members.map((m) => [m, []]));
  edgeList.forEach(([, e]) => adj0.get(e.from).push(e.to));
  for (const l of adj0.values()) l.sort();
  const allCycles = enumerateCycles(members, adj0)
    .map((nodes) => {
      const edges = [];
      for (let i = 0; i < nodes.length; i++) {
        edges.push(edgeIndex.get(nodes[i] + '→' + nodes[(i + 1) % nodes.length]));
      }
      return { key: nodes.join('→'), nodes, edges };
    })
    .sort((a, b) => (a.key < b.key ? -1 : 1));

  const liveCycles = (st) => {
    const out = [];
    for (const c of allCycles) {
      let bn = Infinity;
      for (const ei of c.edges) {
        if (st[ei] === 0) { bn = 0; break; }
        if (st[ei] < bn) bn = st[ei];
      }
      if (bn > 0) out.push({ key: c.key, nodes: c.nodes, edges: c.edges, bn });
    }
    return out;
  };

  const cancel = (st, c) => {
    const st2 = st.slice();
    for (const ei of c.edges) st2[ei] -= c.bn;
    return st2;
  };

  // Phase 1: minimum achievable residual (memoised over residual states).
  // Lower bound: residual net flow equals the (invariant) net positions,
  // so residual gross can never drop below the sum of positive positions.
  let lowerBound = 0;
  for (const p of graph.positions.values()) if (p > 0) lowerBound += p;
  const memo = new Map();
  function minRes(st) {
    const key = st.join(',');
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const cs = liveCycles(st);
    let r;
    if (cs.length === 0) {
      r = sum(st);
    } else {
      r = Infinity;
      for (const c of cs) {
        const v = minRes(cancel(st, c));
        if (v < r) r = v;
        if (r === lowerBound) break;
      }
    }
    memo.set(key, r);
    return r;
  }
  const best = minRes(st0);

  // Phase 2: enumerate every solution that attains the minimum. Solutions
  // reachable from a residual state do not depend on how the state was
  // reached, so suffixes are memoised and shared; orderings of the same
  // cycle multiset collapse to one normalised solution.
  const residualOf = (st) => {
    const out = [];
    st.forEach((amt, i) => {
      if (amt > 0) {
        out.push({
          from: edgeList[i][1].from,
          to: edgeList[i][1].to,
          amount: amt,
          obligations: [...edgeList[i][1].obs],
        });
      }
    });
    return out;
  };
  const cycleInfo = new Map(); // canonical key -> { nodes, edgeIdx }
  const cmpCycle = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]);
  const solveMemo = new Map();
  function solve(st) {
    const key = st.join(',');
    const hit = solveMemo.get(key);
    if (hit) return hit;
    const cs = liveCycles(st);
    let out;
    if (cs.length === 0) {
      out = [{ cycles: [], residual: residualOf(st) }];
    } else {
      const map = new Map();
      for (const c of cs) {
        cycleInfo.set(c.key, { nodes: c.nodes, edgeIdx: c.edges });
        const st2 = cancel(st, c);
        if (minRes(st2) !== best) continue;
        for (const suf of solve(st2)) {
          const cycles = [...suf.cycles, [c.key, c.bn]].sort(cmpCycle);
          const norm = JSON.stringify([cycles, suf.residual.map((r) => [r.from, r.to, r.amount])]);
          if (!map.has(norm)) map.set(norm, { cycles, residual: suf.residual });
        }
      }
      out = [...map.values()];
    }
    solveMemo.set(key, out);
    return out;
  }

  const rawSolutions = solve(st0);
  const solutions = rawSolutions.map((s) => {
    const cycles = s.cycles.map(([ckey, amount]) => {
      const info = cycleInfo.get(ckey);
      return {
        key: ckey,
        cycle: info.nodes,
        amount,
        edges: info.edgeIdx.map((ei) => ({
          from: edgeList[ei][1].from,
          to: edgeList[ei][1].to,
          cancelled: amount,
          obligations: [...edgeList[ei][1].obs],
        })),
      };
    });
    assertUniqueCycles(cycles);
    return { cash: best, cycles, settlements: s.residual };
  });
  solutions.sort((a, b) => {
    const ka = JSON.stringify(a.cycles.map((c) => [c.key, c.amount]))
      + JSON.stringify(a.settlements.map((s) => [s.from, s.to, s.amount]));
    const kb = JSON.stringify(b.cycles.map((c) => [c.key, c.amount]))
      + JSON.stringify(b.settlements.map((s) => [s.from, s.to, s.amount]));
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  return { minCash: best, gross: sum(st0), solutions };
}

function isAcyclic(members, edges) {
  const adj = new Map(members.map((m) => [m, []]));
  for (const e of edges) adj.get(e.from).push(e.to);
  const state = new Map(); // 0=unvisited 1=in-stack 2=done
  const dfs = (u) => {
    state.set(u, 1);
    for (const v of adj.get(u) || []) {
      if (state.get(v) === 1) return false;
      if (!state.get(v) && !dfs(v)) return false;
    }
    state.set(u, 2);
    return true;
  };
  return members.every((m) => state.get(m) || dfs(m));
}

// Independent invariant check for one solution:
//  - residual net flow equals the original net position of every member
//  - cancelled cycles + residual exactly account for the original gross
//  - the residual settlement graph is acyclic
export function verifySolution(graph, sol) {
  const flow = new Map();
  const add = (m, d) => flow.set(m, (flow.get(m) || 0) + d);
  for (const s of sol.settlements) {
    add(s.to, s.amount);
    add(s.from, -s.amount);
  }
  for (const [m, p] of graph.positions) {
    if ((flow.get(m) || 0) !== p) return false;
  }
  const cancelled = sol.cycles.reduce((a, c) => a + c.amount * c.cycle.length, 0);
  const gross = [...graph.edges.values()].reduce((a, e) => a + e.amount, 0);
  const residSum = sol.settlements.reduce((a, s) => a + s.amount, 0);
  if (cancelled + residSum !== gross) return false;
  if (sol.cash !== residSum) return false;
  return isAcyclic([...graph.members], sol.settlements);
}
