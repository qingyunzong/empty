// Independent brute-force reference used by the test-suite to cross-check
// the main engine. Written separately from src/netting.js: it recomputes
// everything from raw (member, edge) lists with its own cycle finder.
export function referenceOptimize(memberList, edgeList) {
  const members = [...new Set(memberList)].sort();
  const edges = edgeList.map((e) => ({ from: e.from, to: e.to, amount: e.amount }));
  const n = edges.length;

  // All simple cycles of the full graph, found once by DFS from each node.
  const allCycles = (() => {
    const adj = new Map(members.map((m) => [m, []]));
    edges.forEach((e, i) => adj.get(e.from).push({ to: e.to, i }));
    const found = new Map();
    for (const s of members) {
      const path = [s];
      const edgePath = [];
      const onPath = new Set([s]);
      (function dfs(u) {
        for (const { to, i } of adj.get(u)) {
          if (to === s && path.length >= 2) {
            found.set(path.join('→'), { nodes: [...path], edgeIdx: [...edgePath, i] });
          } else if (to > s && !onPath.has(to)) {
            onPath.add(to);
            path.push(to);
            edgePath.push(i);
            dfs(to);
            edgePath.pop();
            path.pop();
            onPath.delete(to);
          }
        }
      })(s);
    }
    return [...found.values()]
      .sort((a, b) => (a.nodes.join('→') < b.nodes.join('→') ? -1 : 1));
  })();

  function findCycles(st) {
    const out = [];
    for (const c of allCycles) {
      let bn = Infinity;
      for (const i of c.edgeIdx) {
        if (st[i] === 0) { bn = 0; break; }
        if (st[i] < bn) bn = st[i];
      }
      if (bn > 0) out.push({ nodes: c.nodes, edgeIdx: c.edgeIdx, bn });
    }
    return out;
  }

  const memo = new Map();
  function minRes(st) {
    const key = st.join(',');
    if (memo.has(key)) return memo.get(key);
    const cs = findCycles(st);
    let r;
    if (cs.length === 0) {
      r = st.reduce((a, b) => a + b, 0);
    } else {
      r = Infinity;
      for (const c of cs) {
        const st2 = st.slice();
        for (const i of c.edgeIdx) st2[i] -= c.bn;
        r = Math.min(r, minRes(st2));
      }
    }
    memo.set(key, r);
    return r;
  }

  const st0 = edges.map((e) => e.amount);
  const best = minRes(st0);

  // Suffix-memoised enumeration of every tied optimum (normalised keys).
  const solveMemo = new Map();
  function solve(st) {
    const key = st.join(',');
    if (solveMemo.has(key)) return solveMemo.get(key);
    const cs = findCycles(st);
    let out;
    if (cs.length === 0) {
      const res = [];
      st.forEach((a, i) => { if (a > 0) res.push([edges[i].from, edges[i].to, a]); });
      res.sort();
      out = [JSON.stringify({ c: [], r: res })];
    } else {
      const set = new Set();
      for (const c of cs) {
        const st2 = st.slice();
        for (const i of c.edgeIdx) st2[i] -= c.bn;
        if (minRes(st2) !== best) continue;
        for (const suf of solve(st2)) {
          const parsed = JSON.parse(suf);
          parsed.c.push([c.nodes.join('→'), c.bn]);
          parsed.c.sort();
          set.add(JSON.stringify(parsed));
        }
      }
      out = [...set];
    }
    solveMemo.set(key, out);
    return out;
  }

  return { minCash: best, solKeys: new Set(solve(st0)) };
}
