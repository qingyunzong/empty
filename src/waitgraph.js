// Reference small-scale wait-for graph cycle enumeration.
// Graph is Map<node, Iterable<node>>. Returns all elementary cycles,
// each canonicalized to start at its smallest node.
export function enumerateCycles(graph) {
  const nodes = [...graph.keys()].sort((a, b) => a - b);
  const cycles = [];
  const seen = new Set();
  for (const start of nodes) {
    const stack = [start];
    const onPath = new Set([start]);
    const dfs = (node) => {
      for (const next of graph.get(node) ?? []) {
        if (next === start) {
          const rotated = canonical(stack);
          const key = rotated.join(',');
          if (!seen.has(key)) {
            seen.add(key);
            cycles.push(rotated);
          }
        } else if (next > start && !onPath.has(next)) {
          onPath.add(next);
          stack.push(next);
          dfs(next);
          stack.pop();
          onPath.delete(next);
        }
      }
    };
    dfs(start);
  }
  return cycles;
}

function canonical(cycle) {
  let minIdx = 0;
  for (let i = 1; i < cycle.length; i++) {
    if (cycle[i] < cycle[minIdx]) minIdx = i;
  }
  return [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
}
