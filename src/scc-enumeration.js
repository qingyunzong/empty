// Independent SCC implementation used only for cross-checking.
// Computes the full reachability matrix (Floyd-Warshall transitive closure)
// and then enumerates node groupings by mutual reachability.
export function enumerationScc(nodes, edges) {
  const ordered = [...nodes].sort((a, b) => a - b);
  const size = ordered.length;
  const indexOf = new Map(ordered.map((node, i) => [node, i]));
  const reach = Array.from({ length: size }, (_, i) =>
    Array.from({ length: size }, (_, j) => i === j),
  );
  for (const [from, to] of edges) {
    reach[indexOf.get(from)][indexOf.get(to)] = true;
  }
  for (let k = 0; k < size; k += 1) {
    for (let i = 0; i < size; i += 1) {
      if (!reach[i][k]) continue;
      for (let j = 0; j < size; j += 1) {
        if (reach[k][j]) reach[i][j] = true;
      }
    }
  }
  const used = new Array(size).fill(false);
  const sccs = [];
  for (let i = 0; i < size; i += 1) {
    if (used[i]) continue;
    const component = [];
    for (let j = 0; j < size; j += 1) {
      if (!used[j] && reach[i][j] && reach[j][i]) {
        component.push(ordered[j]);
        used[j] = true;
      }
    }
    component.sort((a, b) => a - b);
    sccs.push(component);
  }
  return sccs;
}
