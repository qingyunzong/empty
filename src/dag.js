'use strict';

// Would adding `deps` to node `id` create a cycle? A cycle exists iff some
// new dependency can reach `id` by following existing dep edges.
function createsCycle(nodes, id, deps) {
  for (const start of deps) {
    if (start === id) return true;
    const seen = new Set();
    const stack = [start];
    while (stack.length > 0) {
      const u = stack.pop();
      if (u === id) return true;
      if (seen.has(u)) continue;
      seen.add(u);
      const node = nodes[u];
      if (!node) continue;
      for (const d of node.deps) stack.push(d);
    }
  }
  return false;
}

// All nodes that transitively depend on `id` (excluding `id` itself).
function descendants(nodes, id) {
  const dependents = new Map();
  for (const [nid, n] of Object.entries(nodes)) {
    for (const d of n.deps) {
      if (!dependents.has(d)) dependents.set(d, []);
      dependents.get(d).push(nid);
    }
  }
  const out = new Set();
  const stack = [id];
  while (stack.length > 0) {
    const u = stack.pop();
    for (const v of dependents.get(u) ?? []) {
      if (!out.has(v)) {
        out.add(v);
        stack.push(v);
      }
    }
  }
  return out;
}

// The exact subtree affected by correcting `id`: itself plus all transitive
// dependents, sorted for deterministic output.
function affectedSubtree(nodes, id) {
  const set = descendants(nodes, id);
  set.add(id);
  return [...set].sort();
}

module.exports = { createsCycle, descendants, affectedSubtree };
