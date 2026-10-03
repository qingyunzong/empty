'use strict';

class DependencyGraph {
  constructor() {
    this.dependents = new Map();
  }

  addEdge(from, to) {
    let set = this.dependents.get(from);
    if (!set) {
      set = new Set();
      this.dependents.set(from, set);
    }
    set.add(to);
  }

  removeEdge(from, to) {
    const set = this.dependents.get(from);
    if (!set) return;
    set.delete(to);
    if (set.size === 0) this.dependents.delete(from);
  }

  invalidate(roots) {
    const dirty = new Set();
    const stack = [...roots];
    while (stack.length > 0) {
      const node = stack.pop();
      if (dirty.has(node)) continue;
      dirty.add(node);
      const next = this.dependents.get(node);
      if (next) for (const dependent of next) stack.push(dependent);
    }
    return dirty;
  }
}

module.exports = { DependencyGraph };
