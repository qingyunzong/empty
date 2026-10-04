'use strict';

// Edmonds-Karp max flow over a directed multigraph collapsed into
// per-ordered-pair capacities. Handles anti-parallel edges via net flow.
//
// capacity: Map<from, Map<to, cap>> (non-negative numbers)
// Returns { value, flow: Map<from, Map<to, f>>, reachable: Set }
// where `reachable` is the source side of a min cut in the residual graph.
function maxFlow(capacity, source, sink) {
  const nodes = new Set();
  for (const [u, row] of capacity) {
    nodes.add(u);
    for (const v of row.keys()) nodes.add(v);
  }
  nodes.add(source);
  nodes.add(sink);

  const residual = new Map();
  const net = new Map();
  for (const u of nodes) {
    residual.set(u, new Map());
    net.set(u, new Map());
    for (const v of nodes) {
      residual.get(u).set(v, 0);
      net.get(u).set(v, 0);
    }
  }
  for (const [u, row] of capacity) {
    for (const [v, c] of row) {
      residual.get(u).set(v, residual.get(u).get(v) + c);
    }
  }

  let value = 0;
  for (;;) {
    const prev = new Map([[source, null]]);
    const queue = [source];
    for (let head = 0; head < queue.length && !prev.has(sink); head++) {
      const u = queue[head];
      for (const [v, c] of residual.get(u)) {
        if (c > 0 && !prev.has(v)) {
          prev.set(v, u);
          queue.push(v);
        }
      }
    }
    if (!prev.has(sink)) break;

    let bottleneck = Infinity;
    for (let v = sink; v !== source; v = prev.get(v)) {
      bottleneck = Math.min(bottleneck, residual.get(prev.get(v)).get(v));
    }
    for (let v = sink; v !== source; v = prev.get(v)) {
      const u = prev.get(v);
      residual.get(u).set(v, residual.get(u).get(v) - bottleneck);
      residual.get(v).set(u, residual.get(v).get(u) + bottleneck);
      net.get(u).set(v, net.get(u).get(v) + bottleneck);
      net.get(v).set(u, net.get(v).get(u) - bottleneck);
    }
    value += bottleneck;
  }

  const reachable = new Set([source]);
  const queue = [source];
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head];
    for (const [v, c] of residual.get(u)) {
      if (c > 0 && !reachable.has(v)) {
        reachable.add(v);
        queue.push(v);
      }
    }
  }

  const flow = new Map();
  for (const u of nodes) flow.set(u, new Map());
  for (const [u, row] of capacity) {
    for (const [v] of row) {
      const f = Math.max(0, net.get(u).get(v));
      if (f > 0) flow.get(u).set(v, f);
    }
  }

  return { value, flow, reachable };
}

module.exports = { maxFlow };
