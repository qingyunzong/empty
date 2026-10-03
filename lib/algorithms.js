'use strict';

function cmpStr(x, y) {
  return x < y ? -1 : x > y ? 1 : 0;
}

function buildAdjacency(nodes, edges) {
  const adj = new Map();
  for (const node of nodes) adj.set(node, []);
  for (const edge of edges) {
    adj.get(edge.a).push({ to: edge.b, id: edge.id });
    adj.get(edge.b).push({ to: edge.a, id: edge.id });
  }
  return adj;
}

function connectedComponents(nodes, edges) {
  const adj = buildAdjacency(nodes, edges);
  const seen = new Set();
  const components = [];
  for (const start of [...nodes].sort(cmpStr)) {
    if (seen.has(start)) continue;
    const component = [];
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const u = stack.pop();
      component.push(u);
      for (const { to } of adj.get(u)) {
        if (!seen.has(to)) {
          seen.add(to);
          stack.push(to);
        }
      }
    }
    components.push(component.sort(cmpStr));
  }
  components.sort((x, y) => cmpStr(x[0], y[0]) || x.length - y.length);
  return components;
}

// Tarjan bridge-finding on an undirected multigraph (edge-id aware, so
// parallel edges are handled correctly). Returns the list of bridge edge ids.
function tarjanBridges(nodes, edges) {
  const adj = buildAdjacency(nodes, edges);
  const disc = new Map();
  const low = new Map();
  let time = 0;
  const bridges = [];
  function dfs(u, parentEdgeId) {
    disc.set(u, time);
    low.set(u, time);
    time += 1;
    for (const { to, id } of adj.get(u)) {
      if (id === parentEdgeId) continue;
      if (!disc.has(to)) {
        dfs(to, id);
        low.set(u, Math.min(low.get(u), low.get(to)));
        if (low.get(to) > disc.get(u)) bridges.push(id);
      } else {
        low.set(u, Math.min(low.get(u), disc.get(to)));
      }
    }
  }
  for (const node of nodes) {
    if (!disc.has(node)) dfs(node, null);
  }
  return bridges;
}

// Reference implementation: remove each edge in turn and check whether the
// number of connected components grows. Used to cross-check Tarjan.
function enumerationBridges(nodes, edges) {
  const baseline = connectedComponents(nodes, edges).length;
  const bridges = [];
  for (const edge of edges) {
    const rest = edges.filter((other) => other.id !== edge.id);
    if (connectedComponents(nodes, rest).length > baseline) bridges.push(edge.id);
  }
  return bridges;
}

// Shortest path (fewest hops); among equally short paths pick the
// lexicographically smallest node sequence. Returns null when unreachable.
function shortestPath(nodes, edges, from, to) {
  const adj = buildAdjacency(nodes, edges);
  if (!adj.has(from) || !adj.has(to)) return null;
  const dist = new Map([[to, 0]]);
  const queue = [to];
  while (queue.length > 0) {
    const u = queue.shift();
    for (const { to: v } of adj.get(u)) {
      if (!dist.has(v)) {
        dist.set(v, dist.get(u) + 1);
        queue.push(v);
      }
    }
  }
  if (!dist.has(from)) return null;
  const path = [from];
  let current = from;
  while (current !== to) {
    let best = null;
    for (const { to: v } of adj.get(current)) {
      if (dist.get(v) === dist.get(current) - 1 && (best === null || cmpStr(v, best) < 0)) {
        best = v;
      }
    }
    if (best === null) return null;
    path.push(best);
    current = best;
  }
  return path;
}

module.exports = {
  cmpStr,
  buildAdjacency,
  connectedComponents,
  tarjanBridges,
  enumerationBridges,
  shortestPath,
};
