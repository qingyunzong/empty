import { RouteError } from './errors.js';

export { RouteError };

export function comparePaths(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

function reachable(graph, start, end) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const u = queue.shift();
    if (u === end) return true;
    for (const v of graph.adj.get(u) ?? []) {
      if (!seen.has(v) && graph.nodes.has(v)) {
        seen.add(v);
        queue.push(v);
      }
    }
  }
  return false;
}

export function findBestPath(graph, start, end) {
  if (!graph.nodes.has(start)) throw new RouteError('E_NO_PATH', `unknown start node: ${start}`);
  if (!graph.nodes.has(end)) throw new RouteError('E_NO_PATH', `unknown end node: ${end}`);
  if (graph.hasCycle()) throw new RouteError('E_CYCLE', 'process graph contains a cycle');
  if (!reachable(graph, start, end)) {
    throw new RouteError('E_NO_PATH', `no path from ${start} to ${end}`);
  }

  const capacityOf = (dev) => (graph.devices.has(dev) ? graph.devices.get(dev).capacity : Infinity);
  const loads = new Map();
  const visited = new Set();
  const path = [];
  let best = null;

  function dfs(u, time) {
    const node = graph.nodes.get(u);
    const dev = node.device;
    let applied = false;
    if (dev != null) {
      const next = (loads.get(dev) ?? 0) + node.load;
      if (next > capacityOf(dev)) return;
      loads.set(dev, next);
      applied = true;
    }
    const total = time + node.time;
    visited.add(u);
    path.push(u);
    if (u === end) {
      if (!best || total < best.time || (total === best.time && comparePaths(path, best.path) < 0)) {
        best = { path: path.slice(), time: total };
      }
    } else {
      for (const v of graph.neighbors(u)) {
        if (!visited.has(v) && graph.nodes.has(v)) dfs(v, total);
      }
    }
    path.pop();
    visited.delete(u);
    if (applied) loads.set(dev, loads.get(dev) - node.load);
  }

  dfs(start, 0);
  if (!best) {
    throw new RouteError('E_CAPACITY', `device daily capacity exceeded on every path from ${start} to ${end}`);
  }
  return best;
}
