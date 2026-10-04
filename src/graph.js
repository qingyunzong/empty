// Minimal incremental dependency graph.
// Nodes are derived values; edges point dependency -> dependent.
// invalidate() marks a node dirty and propagates to transitive dependents.
// get() recomputes only dirty nodes (differential maintenance), memoizing clean ones.

export class DepGraph {
  constructor() {
    this.nodes = new Map(); // id -> { compute, deps:Set, dependents:Set, dirty, value }
  }

  addNode(id, compute, deps = []) {
    const existing = this.nodes.get(id);
    if (existing) {
      for (const d of existing.deps) this.nodes.get(d)?.dependents.delete(id);
    }
    const node = existing ?? { dependents: new Set(), value: undefined };
    node.compute = compute;
    node.deps = new Set(deps);
    node.dirty = true;
    this.nodes.set(id, node);
    for (const d of node.deps) {
      const dep = this.nodes.get(d);
      if (dep) dep.dependents.add(id);
    }
    return node;
  }

  removeNode(id) {
    const node = this.nodes.get(id);
    if (!node) return;
    for (const d of node.deps) this.nodes.get(d)?.dependents.delete(id);
    for (const dep of node.dependents) this.invalidate(dep);
    this.nodes.delete(id);
  }

  invalidate(id) {
    const node = this.nodes.get(id);
    if (!node || node.dirty) return;
    node.dirty = true;
    for (const dep of node.dependents) this.invalidate(dep);
  }

  get(id) {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`unknown graph node: ${id}`);
    if (node.dirty) {
      node.value = node.compute((depId) => this.get(depId));
      node.dirty = false;
    }
    return node.value;
  }
}
