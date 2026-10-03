'use strict';

class DepGraph {
  constructor() {
    this.nodes = new Map();
  }
  addNode(id, compute) {
    if (!this.nodes.has(id)) {
      this.nodes.set(id, { id, compute, deps: new Set(), dependents: new Set(), dirty: true });
    } else if (compute) {
      this.nodes.get(id).compute = compute;
    }
    return id;
  }
  addEdge(from, to) {
    const a = this.nodes.get(from);
    const b = this.nodes.get(to);
    if (!a || !b) throw new Error(`edge on missing node: ${from} -> ${to}`);
    a.dependents.add(to);
    b.deps.add(from);
  }
  removeEdge(from, to) {
    const a = this.nodes.get(from);
    const b = this.nodes.get(to);
    if (a) a.dependents.delete(to);
    if (b) b.deps.delete(from);
  }
  invalidate(id) {
    const seen = new Set();
    const stack = [id];
    while (stack.length) {
      const nid = stack.pop();
      if (seen.has(nid)) continue;
      seen.add(nid);
      const n = this.nodes.get(nid);
      if (!n) continue;
      n.dirty = true;
      for (const d of n.dependents) stack.push(d);
    }
  }
  recompute() {
    for (let guard = 0; guard < 1000000; guard++) {
      let node = null;
      for (const n of this.nodes.values()) {
        if (!n.dirty) continue;
        let ready = true;
        for (const d of n.deps) {
          const dn = this.nodes.get(d);
          if (dn && dn.dirty) { ready = false; break; }
        }
        if (ready) { node = n; break; }
        if (!node) node = n;
      }
      if (!node) return;
      node.dirty = false;
      node.compute();
    }
    throw new Error('dependency graph recompute did not converge');
  }
}

module.exports = { DepGraph };
