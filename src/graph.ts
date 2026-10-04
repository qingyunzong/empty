/**
 * Directed dependency graph. An edge `a -> b` means "a depends on b"
 * (a is the dependent, b is the dependency). Reverse edges are maintained
 * so that invalidation can walk from a changed key to everything that
 * transitively depends on it.
 */
export class DependencyGraph {
  private out = new Map<string, Set<string>>(); // dependent -> dependencies
  private into = new Map<string, Set<string>>(); // dependency -> dependents

  /** Replace the recorded dependencies of `key` (deps change across rebuilds). */
  recordDependencies(key: string, deps: Iterable<string>): void {
    const prev = this.out.get(key);
    if (prev) {
      for (const dep of prev) this.into.get(dep)?.delete(key);
    }
    const next = new Set(deps);
    this.out.set(key, next);
    for (const dep of next) {
      let rim = this.into.get(dep);
      if (!rim) {
        rim = new Set();
        this.into.set(dep, rim);
      }
      rim.add(key);
    }
  }

  remove(key: string): void {
    this.recordDependencies(key, []);
    for (const dependent of this.into.get(key) ?? []) {
      this.out.get(dependent)?.delete(key);
    }
    this.into.delete(key);
    this.out.delete(key);
  }

  dependencies(key: string): ReadonlySet<string> {
    return this.out.get(key) ?? new Set();
  }

  dependents(key: string): ReadonlySet<string> {
    return this.into.get(key) ?? new Set();
  }

  keys(): string[] {
    return [...this.out.keys()];
  }

  /**
   * Everything reachable from `changed` by walking reverse edges, including
   * the changed keys themselves: exactly the set that must be invalidated.
   */
  reverseClosure(changed: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const key of changed) {
      if (!seen.has(key)) {
        seen.add(key);
        queue.push(key);
      }
    }
    while (queue.length > 0) {
      const key = queue.pop() as string;
      for (const dependent of this.dependents(key)) {
        if (!seen.has(dependent)) {
          seen.add(dependent);
          queue.push(dependent);
        }
      }
    }
    return seen;
  }

  /** Tarjan's strongly connected components, in reverse topological order. */
  stronglyConnectedComponents(): string[][] {
    const index = new Map<string, number>();
    const lowlink = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const sccs: string[][] = [];
    let counter = 0;

    const strongconnect = (root: string): void => {
      // Iterative Tarjan to avoid stack overflow on large graphs.
      const work: Array<{ node: string; childIter: Iterator<string> }> = [];
      index.set(root, counter);
      lowlink.set(root, counter);
      counter += 1;
      stack.push(root);
      onStack.add(root);
      work.push({ node: root, childIter: this.dependencies(root)[Symbol.iterator]() });

      while (work.length > 0) {
        const frame = work[work.length - 1] as { node: string; childIter: Iterator<string> };
        const step = frame.childIter.next();
        if (!step.done) {
          const child = step.value as string;
          if (!index.has(child)) {
            index.set(child, counter);
            lowlink.set(child, counter);
            counter += 1;
            stack.push(child);
            onStack.add(child);
            work.push({ node: child, childIter: this.dependencies(child)[Symbol.iterator]() });
          } else if (onStack.has(child)) {
            lowlink.set(frame.node, Math.min(lowlink.get(frame.node) as number, index.get(child) as number));
          }
          continue;
        }
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1] as { node: string };
          lowlink.set(parent.node, Math.min(lowlink.get(parent.node) as number, lowlink.get(frame.node) as number));
        }
        if (lowlink.get(frame.node) === index.get(frame.node)) {
          const scc: string[] = [];
          let member: string;
          do {
            member = stack.pop() as string;
            onStack.delete(member);
            scc.push(member);
          } while (member !== frame.node);
          sccs.push(scc);
        }
      }
    };

    for (const key of this.out.keys()) {
      if (!index.has(key)) strongconnect(key);
    }
    return sccs;
  }

  /**
   * A concrete witness for one cycle: a path [k0, k1, ..., k0] where every
   * consecutive pair is a real edge in the graph. Returns null when acyclic
   * from `start` within `members`.
   */
  private cyclePathWithin(start: string, members: Set<string>): string[] | null {
    const parent = new Map<string, string>();
    const stack: string[] = [start];
    const visited = new Set<string>();
    while (stack.length > 0) {
      const node = stack.pop() as string;
      for (const dep of this.dependencies(node)) {
        if (!members.has(dep)) continue;
        if (dep === start) {
          const path: string[] = [];
          let cur = node;
          while (cur !== start) {
            path.unshift(cur);
            cur = parent.get(cur) as string;
          }
          path.unshift(start);
          path.push(start);
          return path;
        }
        if (!visited.has(dep)) {
          visited.add(dep);
          parent.set(dep, node);
          stack.push(dep);
        }
      }
    }
    return null;
  }

  /**
   * All cycles in the graph, each with the member set and a concrete
   * evidence path. Self-loops count as cycles.
   */
  cycles(): Array<{ members: string[]; evidence: string[] }> {
    const result: Array<{ members: string[]; evidence: string[] }> = [];
    for (const scc of this.stronglyConnectedComponents()) {
      const isSelfLoop = scc.length === 1 && this.dependencies(scc[0] as string).has(scc[0] as string);
      if (scc.length === 1 && !isSelfLoop) continue;
      const members = new Set(scc);
      const start = scc[0] as string;
      const evidence = isSelfLoop ? [start, start] : this.cyclePathWithin(start, members);
      result.push({ members: [...scc].sort(), evidence: evidence ?? [start] });
    }
    return result;
  }
}
