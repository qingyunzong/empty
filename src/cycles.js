// Enumerate all elementary directed cycles of an adjacency map.
// adj: Map<node, Iterable<node>>. Returns arrays of nodes, each rotated so
// the lexicographically smallest node is first. Each cycle appears once.
export function findCycles(adj) {
  const nodes = [...adj.keys()].sort();
  const cycles = [];
  for (const start of nodes) {
    const allowed = new Set(nodes.filter((n) => n >= start));
    const path = [start];
    const onPath = new Set([start]);
    const dfs = (u) => {
      const neighbors = adj.get(u);
      if (!neighbors) return;
      for (const v of neighbors) {
        if (!allowed.has(v)) continue;
        if (v === start) {
          if (path.length >= 2) cycles.push([...path]);
          continue;
        }
        if (onPath.has(v)) continue;
        onPath.add(v);
        path.push(v);
        dfs(v);
        path.pop();
        onPath.delete(v);
      }
    };
    dfs(start);
  }
  return cycles;
}

export function cycleKey(cycleNodes) {
  return cycleNodes.join('→');
}
