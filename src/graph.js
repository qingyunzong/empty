export class CycleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CycleError';
    this.code = 'CYCLE';
  }
}

export class DependencyGraph {
  #out = new Map();
  #in = new Map();

  constructor() {
    this.nodes = new Map();
  }

  addNode(id) {
    if (!this.nodes.has(id)) {
      this.nodes.set(id, { id, dirty: false });
      this.#out.set(id, new Set());
      this.#in.set(id, new Set());
    }
    return this.nodes.get(id);
  }

  hasNode(id) {
    return this.nodes.has(id);
  }

  hasEdge(from, to) {
    return this.#out.get(from)?.has(to) ?? false;
  }

  #reachable(start, target) {
    const stack = [start];
    const seen = new Set([start]);
    while (stack.length) {
      const node = stack.pop();
      if (node === target) return true;
      for (const next of this.#out.get(node) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return false;
  }

  wouldCycle(from, to) {
    if (from === to) return true;
    return this.#reachable(to, from);
  }

  addEdge(from, to) {
    this.addNode(from);
    this.addNode(to);
    if (this.wouldCycle(from, to)) {
      throw new CycleError(`adding edge ${from} -> ${to} would create a cycle`);
    }
    this.#out.get(from).add(to);
    this.#in.get(to).add(from);
  }

  removeEdge(from, to) {
    this.#out.get(from)?.delete(to);
    this.#in.get(to)?.delete(from);
  }

  invalidate(id) {
    const order = [];
    const stack = [id];
    const seen = new Set([id]);
    while (stack.length) {
      const nodeId = stack.pop();
      const node = this.nodes.get(nodeId);
      if (!node) continue;
      if (!node.dirty) {
        node.dirty = true;
        order.push(nodeId);
      }
      for (const next of this.#out.get(nodeId) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return order;
  }

  dirtyNodes() {
    return [...this.nodes.values()].filter((n) => n.dirty).map((n) => n.id);
  }

  clearDirty(id) {
    const node = this.nodes.get(id);
    if (node) node.dirty = false;
  }

  topoOrder(ids) {
    const set = new Set(ids);
    const indegree = new Map();
    for (const id of set) {
      let degree = 0;
      for (const from of this.#in.get(id) ?? []) if (set.has(from)) degree++;
      indegree.set(id, degree);
    }
    const queue = ids.filter((id) => indegree.get(id) === 0).sort();
    const order = [];
    while (queue.length) {
      const node = queue.shift();
      order.push(node);
      for (const next of [...(this.#out.get(node) ?? [])].sort()) {
        if (!set.has(next)) continue;
        indegree.set(next, indegree.get(next) - 1);
        if (indegree.get(next) === 0) queue.push(next);
      }
    }
    if (order.length !== set.size) throw new CycleError('dependency cycle during evaluation');
    return order;
  }
}
