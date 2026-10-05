import { PendingError } from './errors.js';

// Directed happens-before graph over effective ops.
// edges: Map<id, string[]> (sorted adjacency)
export function buildGraph(ops, syncPairs) {
  const adj = new Map();
  for (const op of ops) adj.set(op.id, []);
  const byDevice = new Map();
  for (const op of ops) {
    if (!byDevice.has(op.device)) byDevice.set(op.device, []);
    byDevice.get(op.device).push(op);
  }
  // same-device order edges (consecutive effective ops)
  for (const chain of byDevice.values()) {
    for (let i = 0; i + 1 < chain.length; i++) {
      adj.get(chain[i].id).push(chain[i + 1].id);
    }
  }
  // sync rendezvous edges: everything before a's sync happens-before
  // everything after the peer's sync, and vice versa.
  const succOf = new Map();
  for (const chain of byDevice.values()) {
    for (let i = 0; i < chain.length; i++) {
      succOf.set(chain[i].id, i + 1 < chain.length ? chain[i + 1].id : null);
    }
  }
  for (const [a, b] of syncPairs) {
    const succB = succOf.get(b);
    const succA = succOf.get(a);
    if (succB) adj.get(a).push(succB);
    if (succA) adj.get(b).push(succA);
  }
  for (const list of adj.values()) list.sort();
  return adj;
}

// Transitive closure: reach[id] = set of ids reachable from id (exclusive).
export function transitiveClosure(adj, budget) {
  const reach = new Map();
  for (const src of adj.keys()) {
    const seen = new Set();
    const stack = [src];
    while (stack.length) {
      const u = stack.pop();
      for (const v of adj.get(u)) {
        budget.step();
        if (!seen.has(v)) {
          seen.add(v);
          stack.push(v);
        }
      }
    }
    seen.delete(src);
    reach.set(src, seen);
  }
  return reach;
}

// Shortest directed cycle (minimal causal loop). Deterministic:
// nodes/edges scanned in sorted order, first shortest cycle wins.
export function findMinCycle(adj, budget) {
  let best = null;
  const nodes = [...adj.keys()].sort();
  for (const s of nodes) {
    if (best && best.length <= 2) break;
    // BFS from s looking for shortest path back to s
    const parent = new Map();
    const depth = new Map([[s, 0]]);
    const queue = [s];
    let found = null;
    while (queue.length) {
      const u = queue.shift();
      budget.step();
      const du = depth.get(u);
      if (best && du + 1 >= best.length) continue;
      for (const v of adj.get(u)) {
        budget.step();
        if (v === s) {
          if (!found || du + 1 < found.len) {
            // reconstruct cycle s ~> u -> s
            const path = [u];
            let cur = u;
            while (cur !== s) {
              cur = parent.get(cur);
              path.push(cur);
            }
            path.reverse();
            found = { len: du + 1, cycle: path };
          }
        } else if (!depth.has(v)) {
          depth.set(v, du + 1);
          parent.set(v, u);
          queue.push(v);
        }
      }
    }
    if (found && (!best || found.len < best.length)) {
      best = found.cycle;
    }
  }
  return best; // array of op ids, cycle[i] -> cycle[i+1], last -> first
}

// Deterministic Kahn topological order (lexicographic by id on ties).
export function topoSort(adj, budget) {
  const indeg = new Map();
  for (const [u, outs] of adj) {
    if (!indeg.has(u)) indeg.set(u, 0);
    for (const v of outs) {
      budget.step();
      indeg.set(v, (indeg.get(v) || 0) + 1);
    }
  }
  const ready = [...adj.keys()].filter((k) => (indeg.get(k) || 0) === 0).sort();
  const order = [];
  while (ready.length) {
    budget.step();
    const u = ready.shift();
    order.push(u);
    for (const v of adj.get(u)) {
      indeg.set(v, indeg.get(v) - 1);
      if (indeg.get(v) === 0) {
        // insert sorted
        let i = ready.length;
        while (i > 0 && ready[i - 1] > v) i--;
        ready.splice(i, 0, v);
      }
    }
  }
  if (order.length !== adj.size) {
    throw new PendingError('topological sort stalled: graph has a cycle');
  }
  return order;
}

// Enumerate all topological orders (only for tiny graphs, n <= 8 in tests).
export function* allTopoOrders(adj) {
  const indeg = new Map();
  for (const [u, outs] of adj) {
    if (!indeg.has(u)) indeg.set(u, 0);
    for (const v of outs) indeg.set(v, (indeg.get(v) || 0) + 1);
  }
  const nodes = [...adj.keys()].sort();
  const prefix = [];
  const used = new Set();
  function* rec() {
    if (prefix.length === nodes.length) {
      yield [...prefix];
      return;
    }
    for (const n of nodes) {
      if (used.has(n) || indeg.get(n) !== 0) continue;
      used.add(n);
      prefix.push(n);
      for (const v of adj.get(n)) indeg.set(v, indeg.get(v) - 1);
      yield* rec();
      for (const v of adj.get(n)) indeg.set(v, indeg.get(v) + 1);
      prefix.pop();
      used.delete(n);
    }
  }
  yield* rec();
}
