export interface TestCase {
  readonly id: string;
  readonly deps: readonly string[];
}

export function buildDepMap(cases: readonly TestCase[]): Map<string, string[]> {
  const ids = new Set(cases.map((c) => c.id));
  const map = new Map<string, string[]>();
  for (const c of cases) {
    if (map.has(c.id)) throw new Error(`duplicate test id: ${c.id}`);
    const deps: string[] = [];
    for (const d of c.deps) {
      if (!ids.has(d)) throw new Error(`unknown dependency "${d}" of test "${c.id}"`);
      if (!deps.includes(d)) deps.push(d);
    }
    map.set(c.id, deps);
  }
  return map;
}

/** Tarjan SCC over dependency edges (id -> its deps). */
export function stronglyConnectedComponents(depMap: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;

  function visit(v: string): void {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of depMap.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }
    if (lowlink.get(v) === index.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      sccs.push(scc);
    }
  }

  for (const id of depMap.keys()) {
    if (!index.has(id)) visit(id);
  }
  return sccs;
}

/**
 * Tests that must be isolated: members of cyclic SCCs (size > 1, or a
 * self-loop) plus every transitive dependent of those members.
 * Everything else stays executable.
 */
export function findIsolated(depMap: Map<string, string[]>): Set<string> {
  const sccs = stronglyConnectedComponents(depMap);
  const isolated = new Set<string>();
  for (const scc of sccs) {
    const isCycle = scc.length > 1 || (depMap.get(scc[0]) ?? []).includes(scc[0]);
    if (isCycle) for (const id of scc) isolated.add(id);
  }
  // Reverse edges: dependency -> its dependents.
  const dependents = new Map<string, string[]>();
  for (const [id, deps] of depMap) {
    for (const d of deps) {
      const list = dependents.get(d);
      if (list) list.push(id);
      else dependents.set(d, [id]);
    }
  }
  const queue = [...isolated];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    for (const next of dependents.get(cur) ?? []) {
      if (!isolated.has(next)) {
        isolated.add(next);
        queue.push(next);
      }
    }
  }
  return isolated;
}
