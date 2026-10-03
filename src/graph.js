// Enumerate all simple directed cycles (length >= 2) of a directed graph.
// adj: Map<string, string[]> — adjacency list. Neighbor lists need not be sorted.
// Each cycle is returned exactly once, rotated so its lexicographically
// smallest node comes first. Deterministic output order.
export function findCycles(adj) {
  const nodes = [...adj.keys()].sort();
  const cycles = [];
  for (const start of nodes) {
    const stack = [start];
    const onPath = new Set([start]);
    const dfs = (cur) => {
      const next = (adj.get(cur) ?? []).slice().sort();
      for (const nxt of next) {
        if (nxt === start) {
          if (stack.length >= 2) cycles.push([...stack]);
        } else if (nxt > start && !onPath.has(nxt)) {
          onPath.add(nxt);
          stack.push(nxt);
          dfs(nxt);
          stack.pop();
          onPath.delete(nxt);
        }
      }
    };
    dfs(start);
  }
  return cycles;
}
