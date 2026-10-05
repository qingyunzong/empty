// Graph analysis over event partial orders:
// build edge graph -> Tarjan SCC (iterative) -> condensation DAG -> bitset transitive closure.

function tarjan(adj) {
  const n = adj.length;
  const comp = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const disc = new Int32Array(n).fill(-1);
  const onStack = new Uint8Array(n);
  const stack = [];
  const compSizes = [];
  let time = 0;
  let compCount = 0;
  for (let s = 0; s < n; s++) {
    if (disc[s] !== -1) continue;
    const call = [[s, 0]];
    while (call.length) {
      const frame = call[call.length - 1];
      const v = frame[0];
      if (frame[1] === 0) {
        disc[v] = low[v] = time++;
        stack.push(v);
        onStack[v] = 1;
      }
      let recursed = false;
      const adjV = adj[v];
      while (frame[1] < adjV.length) {
        const w = adjV[frame[1]++];
        if (disc[w] === -1) {
          call.push([w, 0]);
          recursed = true;
          break;
        } else if (onStack[w]) {
          low[v] = Math.min(low[v], disc[w]);
        }
      }
      if (recursed) continue;
      if (call.length > 1) {
        const parent = call[call.length - 2][0];
        low[parent] = Math.min(low[parent], low[v]);
      }
      if (low[v] === disc[v]) {
        let size = 0;
        let w;
        do {
          w = stack.pop();
          onStack[w] = 0;
          comp[w] = compCount;
          size++;
        } while (w !== v);
        compSizes.push(size);
        compCount++;
      }
      call.pop();
    }
  }
  return { comp, compCount, compSizes };
}

// events: Map<string, {preds: string[]}>
// Returns graph internals used for canonical comparison.
export function analyzeEvents(events) {
  const index = new Map();
  const ids = [];
  const intern = (id) => {
    let i = index.get(id);
    if (i === undefined) {
      i = ids.length;
      index.set(id, i);
      ids.push(id);
    }
    return i;
  };
  for (const id of events.keys()) intern(id);
  for (const ev of events.values()) for (const p of ev.preds) intern(p);

  const n = ids.length;
  const adj = Array.from({ length: n }, () => []);
  const selfLoop = new Uint8Array(n);
  const directEdges = [];
  for (const [id, ev] of events) {
    const to = index.get(id);
    for (const p of ev.preds) {
      const from = index.get(p);
      if (from === to) {
        selfLoop[to] = 1;
        continue;
      }
      adj[from].push(to);
      directEdges.push([p, id]);
    }
  }

  const { comp, compCount, compSizes } = tarjan(adj);

  const cset = Array.from({ length: compCount }, () => new Set());
  for (let v = 0; v < n; v++) {
    for (const w of adj[v]) {
      if (comp[v] !== comp[w]) cset[comp[v]].add(comp[w]);
    }
  }
  const cadj = cset.map((s) => [...s]);
  const cindeg = new Int32Array(compCount);
  for (let c = 0; c < compCount; c++) for (const s of cadj[c]) cindeg[s]++;

  const indeg = Int32Array.from(cindeg);
  const topo = [];
  const queue = [];
  for (let c = 0; c < compCount; c++) if (indeg[c] === 0) queue.push(c);
  while (queue.length) {
    const c = queue.pop();
    topo.push(c);
    for (const s of cadj[c]) if (--indeg[s] === 0) queue.push(s);
  }

  const words = (compCount + 31) >>> 5;
  const compReach = Array.from({ length: compCount }, () => new Uint32Array(words));
  for (let i = topo.length - 1; i >= 0; i--) {
    const c = topo[i];
    const r = compReach[c];
    r[c >>> 5] |= 1 << (c & 31);
    for (const s of cadj[c]) {
      const rs = compReach[s];
      for (let w = 0; w < words; w++) r[w] |= rs[w];
    }
  }

  const members = Array.from({ length: compCount }, () => []);
  for (let i = 0; i < n; i++) members[comp[i]].push(ids[i]);
  const compKey = members.map((m) => [...m].sort().join(''));
  const coutdeg = new Int32Array(compCount);
  for (let c = 0; c < compCount; c++) coutdeg[c] = cadj[c].length;
  const sources = [];
  const sinks = [];
  for (let c = 0; c < compCount; c++) {
    if (cindeg[c] === 0) sources.push(compKey[c]);
    if (coutdeg[c] === 0) sinks.push(compKey[c]);
  }
  sources.sort();
  sinks.sort();

  const recorded = new Set(events.keys());
  const externals = ids.filter((id) => !recorded.has(id)).sort();

  return {
    ids, index, adj, selfLoop, directEdges,
    comp, compCount, compSizes, compReach,
    recorded, externals, sources, sinks,
  };
}

// Reachability between two node indices of an analyzed log.
export function reachIdx(an, i, j) {
  const ci = an.comp[i];
  const cj = an.comp[j];
  if (ci === cj) return an.compSizes[ci] > 1 || an.selfLoop[i] === 1;
  return ((an.compReach[ci][cj >>> 5] >>> (cj & 31)) & 1) === 1;
}

// Shortest witness path (direct edges) from x to y in an analyzed log.
export function shortestPathEdges(an, x, y) {
  const { ids, adj, index, selfLoop } = an;
  const s = index.get(x);
  const t = index.get(y);
  if (s === undefined || t === undefined) return [];
  if (s === t && selfLoop[s]) return [{ from: x, to: x }];
  const prev = new Int32Array(ids.length).fill(-1);
  const q = [];
  for (const w of adj[s]) {
    if (prev[w] === -1) {
      prev[w] = s;
      q.push(w);
    }
  }
  let head = 0;
  while (head < q.length && prev[t] === -1) {
    const v = q[head++];
    for (const w of adj[v]) {
      if (prev[w] === -1) {
        prev[w] = v;
        q.push(w);
      }
    }
  }
  if (prev[t] === -1) return [];
  const edges = [];
  let cur = t;
  do {
    const p = prev[cur];
    edges.push({ from: ids[p], to: ids[cur] });
    cur = p;
  } while (cur !== s);
  edges.reverse();
  return edges;
}
