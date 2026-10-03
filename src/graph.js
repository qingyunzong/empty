export class CycleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CycleError';
  }
}

// Incremental dependency graph with dynamic topology.
// Nodes carry values; edges point from a dependency to a dependent.
// Changing a source invalidates (dirties) only its transitive dependents,
// and sync() recomputes dirty nodes in topological order.
export class Graph {
  #nodes = new Map(); // id -> { recompute, value, dirty, deps, dependents }

  has(id) {
    return this.#nodes.has(id);
  }

  addNode(id, recompute) {
    if (this.#nodes.has(id)) throw new Error(`node exists: ${id}`);
    this.#nodes.set(id, {
      recompute,
      value: null,
      dirty: true,
      deps: new Set(),
      dependents: new Set(),
    });
  }

  removeNode(id) {
    const node = this.#nodes.get(id);
    if (!node) return;
    for (const dep of [...node.deps]) this.removeEdge(dep, id);
    for (const dependent of [...node.dependents]) this.removeEdge(id, dependent);
    this.#nodes.delete(id);
  }

  hasEdge(from, to) {
    const node = this.#nodes.get(from);
    return node ? node.dependents.has(to) : false;
  }

  #reachable(from, target) {
    const stack = [from];
    const seen = new Set([from]);
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === target) return true;
      for (const next of this.#nodes.get(current).dependents) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return false;
  }

  addEdge(from, to) {
    const a = this.#nodes.get(from);
    const b = this.#nodes.get(to);
    if (!a || !b) throw new Error(`edge endpoint missing: ${from} -> ${to}`);
    if (from === to || this.#reachable(to, from)) {
      throw new CycleError(`adding edge ${from} -> ${to} would create a cycle`);
    }
    if (!a.dependents.has(to)) {
      a.dependents.add(to);
      b.deps.add(from);
    }
    this.#invalidate(to);
  }

  removeEdge(from, to) {
    const a = this.#nodes.get(from);
    const b = this.#nodes.get(to);
    if (!a || !b) return;
    a.dependents.delete(to);
    b.deps.delete(from);
    this.#invalidate(to);
  }

  setValue(id, value) {
    const node = this.#nodes.get(id);
    if (!node) throw new Error(`no node: ${id}`);
    node.value = value;
    node.dirty = false;
    for (const dependent of node.dependents) this.#invalidate(dependent);
  }

  value(id) {
    const node = this.#nodes.get(id);
    return node ? node.value : undefined;
  }

  #invalidate(id) {
    const stack = [id];
    while (stack.length > 0) {
      const current = stack.pop();
      const node = this.#nodes.get(current);
      if (!node || node.dirty) continue;
      node.dirty = true;
      for (const dependent of node.dependents) stack.push(dependent);
    }
  }

  sync(ctx) {
    const order = [];
    const visited = new Set();
    const visit = (id) => {
      if (visited.has(id)) return;
      visited.add(id);
      const node = this.#nodes.get(id);
      for (const dep of node.deps) visit(dep);
      if (node.dirty) order.push(id);
    };
    for (const id of this.#nodes.keys()) visit(id);
    for (const id of order) {
      const node = this.#nodes.get(id);
      const depValues = new Map();
      for (const dep of node.deps) depValues.set(dep, this.#nodes.get(dep).value);
      node.value = node.recompute(depValues, ctx);
      node.dirty = false;
    }
  }
}
