// Graph primitives: SCC (iterative Tarjan), condensation DAG,
// bitset transitive closure, and transitive reduction.
// Edge direction: u -> v means "u is a causal predecessor of v" (u happens-before v).

export function buildGraph(events) {
  const ids = events.map((e) => e.id).sort();
  const index = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  const preds = new Array(n);
  const dangling = [];
  for (const e of events) {
    const i = index.get(e.id);
    const p = [];
    for (const c of e.causes) {
      if (index.has(c)) p.push(index.get(c));
      else dangling.push({ from: c, to: e.id });
    }
    preds[i] = p;
  }
  const succ = Array.from({ length: n }, () => []);
  for (let v = 0; v < n; v++) {
    for (const u of preds[v]) succ[u].push(v);
  }
  return { ids, index, n, preds, succ, dangling };
}

export function scc(n, succ) {
  const indexOf = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack = [];
  const comp = new Int32Array(n).fill(-1);
  const comps = [];
  let nextIndex = 0;

  for (let s = 0; s < n; s++) {
    if (indexOf[s] !== -1) continue;
    const call = [[s, 0]];
    while (call.length > 0) {
      const frame = call[call.length - 1];
      const v = frame[0];
      if (frame[1] === 0) {
        indexOf[v] = low[v] = nextIndex++;
        stack.push(v);
        onStack[v] = 1;
      }
      let recursed = false;
      const children = succ[v];
      while (frame[1] < children.length) {
        const w = children[frame[1]++];
        if (indexOf[w] === -1) {
          call.push([w, 0]);
          recursed = true;
          break;
        } else if (onStack[w]) {
          if (indexOf[w] < low[v]) low[v] = indexOf[w];
        }
      }
      if (recursed) continue;
      if (low[v] === indexOf[v]) {
        const c = [];
        let w;
        do {
          w = stack.pop();
          onStack[w] = 0;
          comp[w] = comps.length;
          c.push(w);
        } while (w !== v);
        comps.push(c);
      }
      call.pop();
      if (call.length > 0) {
        const parent = call[call.length - 1][0];
        if (low[v] < low[parent]) low[parent] = low[v];
      }
    }
  }
  return { comp, comps, compCount: comps.length };
}

export function condensation(n, preds, comp, compCount) {
  const cSucc = Array.from({ length: compCount }, () => new Set());
  for (let v = 0; v < n; v++) {
    for (const u of preds[v]) {
      const cu = comp[u];
      const cv = comp[v];
      if (cu !== cv) cSucc[cu].add(cv);
    }
  }
  // Kahn topological order (predecessors first).
  const indeg = new Int32Array(compCount);
  for (let c = 0; c < compCount; c++) {
    for (const d of cSucc[c]) indeg[d]++;
  }
  const queue = [];
  for (let c = 0; c < compCount; c++) if (indeg[c] === 0) queue.push(c);
  const topo = [];
  for (let head = 0; head < queue.length; head++) {
    const c = queue[head];
    topo.push(c);
    for (const d of cSucc[c]) {
      if (--indeg[d] === 0) queue.push(d);
    }
  }
  const topoRank = new Int32Array(compCount);
  topo.forEach((c, i) => (topoRank[c] = i));
  const cSuccArr = cSucc.map((s) => [...s]);
  return { cSuccArr, topo, topoRank };
}

export function reachability(compCount, cSuccArr, topo) {
  const words = (compCount + 31) >> 5;
  const reach = Array.from({ length: compCount }, () => new Uint32Array(words));
  for (let i = topo.length - 1; i >= 0; i--) {
    const c = topo[i];
    const r = reach[c];
    r[c >> 5] |= 1 << (c & 31);
    for (const d of cSuccArr[c]) {
      const rd = reach[d];
      for (let w = 0; w < words; w++) r[w] |= rd[w];
    }
  }
  return reach;
}

export function transitiveReduction(compCount, cSuccArr, reach, topoRank) {
  const words = (compCount + 31) >> 5;
  const covered = new Uint32Array(words);
  const red = Array.from({ length: compCount }, () => []);
  for (let c = 0; c < compCount; c++) {
    const succs = [...cSuccArr[c]].sort((a, b) => topoRank[a] - topoRank[b]);
    covered.fill(0);
    for (const d of succs) {
      if ((covered[d >> 5] >> (d & 31)) & 1) continue; // implied via another successor
      red[c].push(d);
      const rd = reach[d];
      for (let w = 0; w < words; w++) covered[w] |= rd[w];
    }
  }
  return red;
}

export function bitTest(bits, i) {
  return (bits[i >> 5] >> (i & 31)) & 1;
}
