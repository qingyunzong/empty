/**
 * Tarjan's strongly connected components, returned in topological order of
 * the condensation DAG: a component always appears after the components it
 * depends on (dependencies first).
 */
export function stronglyConnectedComponents(
  nodes: string[],
  edges: Map<string, string[]>,
): string[][] {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  function visit(node: string): void {
    index.set(node, counter);
    lowlink.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);

    for (const next of edges.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next);
        lowlink.set(node, Math.min(lowlink.get(node)!, lowlink.get(next)!));
      } else if (onStack.has(next)) {
        lowlink.set(node, Math.min(lowlink.get(node)!, index.get(next)!));
      }
    }

    if (lowlink.get(node) === index.get(node)) {
      const component: string[] = [];
      for (;;) {
        const popped = stack.pop()!;
        onStack.delete(popped);
        component.push(popped);
        if (popped === node) break;
      }
      components.push(component);
    }
  }

  for (const node of nodes) {
    if (!index.has(node)) visit(node);
  }

  // Topologically sort the condensation DAG (dependencies first).
  const compOf = new Map<string, number>();
  components.forEach((component, i) => {
    for (const node of component) compOf.set(node, i);
  });
  const dependents: Set<number>[] = components.map(() => new Set());
  const remainingDeps = components.map(() => 0);
  components.forEach((component, i) => {
    const deps = new Set<number>();
    for (const node of component) {
      for (const next of edges.get(node) ?? []) {
        const j = compOf.get(next)!;
        if (j !== i) deps.add(j);
      }
    }
    remainingDeps[i] = deps.size;
    for (const j of deps) dependents[j].add(i);
  });
  const ready: number[] = [];
  remainingDeps.forEach((count, i) => {
    if (count === 0) ready.push(i);
  });
  const order: number[] = [];
  while (ready.length > 0) {
    const i = ready.shift()!;
    order.push(i);
    for (const dependent of dependents[i]) {
      remainingDeps[dependent] -= 1;
      if (remainingDeps[dependent] === 0) ready.push(dependent);
    }
  }
  return order.map((i) => components[i]);
}
