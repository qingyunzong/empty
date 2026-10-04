import { RouteError, E } from './errors.js';

function assertAcyclic(graph) {
  const color = new Map(); // 0=unvisited, 1=in stack, 2=done
  const stack = [];
  for (const start of graph.nodes.keys()) {
    if (color.get(start)) continue;
    color.set(start, 1);
    stack.push(start);
    while (stack.length) {
      const top = stack[stack.length - 1];
      let advanced = false;
      for (const nxt of graph.edges.get(top) ?? []) {
        if (!graph.nodes.has(nxt)) continue;
        const c = color.get(nxt) ?? 0;
        if (c === 1) {
          throw new RouteError(E.CYCLE, `cycle detected involving node ${nxt}`, {
            node: nxt,
          });
        }
        if (c === 0) {
          color.set(nxt, 1);
          stack.push(nxt);
          advanced = true;
          break;
        }
      }
      if (!advanced) {
        color.set(top, 2);
        stack.pop();
      }
    }
  }
}

function lexCompare(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

// Enumerates simple paths from `from` to `to` whose operation indices are
// strictly increasing (process precedence), filters by device daily load
// (graph.deviceLoad + path load must fit capacity), and picks the path with
// minimal total processing time, breaking ties by lexicographic node order.
export function findRoute(graph, from, to, capacity = {}) {
  if (!graph.nodes.has(from)) throw new RouteError(E.NOT_FOUND, `unknown node: ${from}`);
  if (!graph.nodes.has(to)) throw new RouteError(E.NOT_FOUND, `unknown node: ${to}`);
  assertAcyclic(graph);

  let anyPath = false;
  let best = null; // { path, time }
  const path = [from];
  const visited = new Set([from]);
  const load = new Map();
  const addLoad = (node, sign) => {
    load.set(node.device, (load.get(node.device) ?? 0) + sign * node.time);
  };
  addLoad(graph.nodes.get(from), 1);

  const consider = () => {
    anyPath = true;
    for (const [dev, t] of load) {
      const limit = capacity[dev];
      if (limit === undefined) continue;
      if ((graph.deviceLoad.get(dev) ?? 0) + t > limit) return; // infeasible
    }
    let time = 0;
    for (const id of path) time += graph.nodes.get(id).time;
    const candidate = { path: [...path], time };
    if (!best || candidate.time < best.time ||
        (candidate.time === best.time && lexCompare(candidate.path, best.path) < 0)) {
      best = candidate;
    }
  };

  const dfs = (cur) => {
    if (cur === to) {
      consider();
      return;
    }
    const curOp = graph.nodes.get(cur).op;
    const neighbors = [...(graph.edges.get(cur) ?? [])].sort();
    for (const nxt of neighbors) {
      if (visited.has(nxt)) continue;
      const node = graph.nodes.get(nxt);
      if (!node) continue;
      if (node.op <= curOp) continue; // process precedence
      visited.add(nxt);
      path.push(nxt);
      addLoad(node, 1);
      dfs(nxt);
      addLoad(node, -1);
      path.pop();
      visited.delete(nxt);
    }
  };
  dfs(from);

  if (best) return best;
  if (anyPath) {
    throw new RouteError(E.CAPACITY, 'device daily capacity insufficient for every route');
  }
  throw new RouteError(E.NO_PATH, `no precedence-respecting path from ${from} to ${to}`);
}
