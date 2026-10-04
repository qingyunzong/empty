export type Key = string;

/**
 * Mutable dependency graph. Edges point from a node to its dependencies;
 * reverse edges are maintained for invalidation propagation.
 */
export class DepGraph {
  private deps = new Map<Key, Set<Key>>();
  private rdeps = new Map<Key, Set<Key>>();

  /** Replace all outgoing dependency edges of `node`. */
  setDeps(node: Key, next: Iterable<Key>): void {
    const old = this.deps.get(node);
    if (old) {
      for (const dep of old) this.rdeps.get(dep)?.delete(node);
    }
    const set = new Set(next);
    this.deps.set(node, set);
    for (const dep of set) {
      let r = this.rdeps.get(dep);
      if (!r) {
        r = new Set();
        this.rdeps.set(dep, r);
      }
      r.add(node);
    }
  }

  dependencies(node: Key): ReadonlySet<Key> {
    return this.deps.get(node) ?? new Set<Key>();
  }

  /** All nodes reachable from `changed` by following reverse (dependent) edges. */
  reverseClosure(changed: Iterable<Key>): Set<Key> {
    const seen = new Set<Key>();
    const queue: Key[] = [];
    for (const key of changed) {
      if (!seen.has(key)) {
        seen.add(key);
        queue.push(key);
      }
    }
    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i];
      for (const dependent of this.rdeps.get(cur) ?? []) {
        if (!seen.has(dependent)) {
          seen.add(dependent);
          queue.push(dependent);
        }
      }
    }
    return seen;
  }

  /** Nodes reachable from `start` by following dependency edges. */
  forwardClosure(start: Key): Set<Key> {
    const seen = new Set<Key>([start]);
    const queue: Key[] = [start];
    for (let i = 0; i < queue.length; i++) {
      for (const dep of this.deps.get(queue[i]) ?? []) {
        if (!seen.has(dep)) {
          seen.add(dep);
          queue.push(dep);
        }
      }
    }
    return seen;
  }

  /** Tarjan's strongly connected components. */
  stronglyConnectedComponents(): Key[][] {
    const index = new Map<Key, number>();
    const low = new Map<Key, number>();
    const onStack = new Set<Key>();
    const stack: Key[] = [];
    const sccs: Key[][] = [];
    let counter = 0;

    const nodes = new Set<Key>([...this.deps.keys(), ...this.rdeps.keys()]);

    const visit = (v: Key): void => {
      index.set(v, counter);
      low.set(v, counter);
      counter++;
      stack.push(v);
      onStack.add(v);
      for (const w of this.deps.get(v) ?? []) {
        if (!index.has(w)) {
          visit(w);
          low.set(v, Math.min(low.get(v)!, low.get(w)!));
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v)!, index.get(w)!));
        }
      }
      if (low.get(v) === index.get(v)) {
        const scc: Key[] = [];
        let w: Key;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          scc.push(w);
        } while (w !== v);
        sccs.push(scc);
      }
    };

    for (const n of nodes) {
      if (!index.has(n)) visit(n);
    }
    return sccs;
  }

  /**
   * Cycle evidence: for every non-trivial SCC (or self-loop), an ordered
   * node path that starts and ends at the same node, e.g. ["A", "B", "A"].
   */
  cycles(): Key[][] {
    const evidence: Key[][] = [];
    for (const scc of this.stronglyConnectedComponents()) {
      if (scc.length === 1) {
        const n = scc[0];
        if (this.deps.get(n)?.has(n)) evidence.push([n, n]);
        continue;
      }
      const members = new Set(scc);
      const start = scc[0];
      // BFS from `start` inside the SCC until some edge leads back to it.
      const parent = new Map<Key, Key>();
      const visited = new Set<Key>([start]);
      const queue: Key[] = [start];
      let last: Key | undefined;
      for (let i = 0; i < queue.length && last === undefined; i++) {
        const cur = queue[i];
        for (const next of this.deps.get(cur) ?? []) {
          if (!members.has(next)) continue;
          if (next === start) {
            last = cur;
            break;
          }
          if (!visited.has(next)) {
            visited.add(next);
            parent.set(next, cur);
            queue.push(next);
          }
        }
      }
      if (last === undefined) {
        evidence.push([...scc, scc[0]]);
        continue;
      }
      const chain: Key[] = [];
      let cur: Key = last;
      while (cur !== start) {
        chain.unshift(cur);
        cur = parent.get(cur)!;
      }
      evidence.push([start, ...chain, start]);
    }
    return evidence;
  }
}
