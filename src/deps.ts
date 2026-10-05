export function collectNodes(
  services: Iterable<string>,
  deps: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const nodes = new Set<string>(services);
  for (const [from, targets] of deps) {
    nodes.add(from);
    for (const to of targets) nodes.add(to);
  }
  return [...nodes].sort();
}

export function stronglyConnectedComponents(
  nodes: readonly string[],
  deps: ReadonlyMap<string, ReadonlySet<string>>,
): string[][] {
  const indexOf = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let nextIndex = 0;

  const visit = (node: string): void => {
    indexOf.set(node, nextIndex);
    lowlink.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of deps.get(node) ?? []) {
      if (!indexOf.has(target)) {
        visit(target);
        lowlink.set(node, Math.min(lowlink.get(node)!, lowlink.get(target)!));
      } else if (onStack.has(target)) {
        lowlink.set(node, Math.min(lowlink.get(node)!, indexOf.get(target)!));
      }
    }
    if (lowlink.get(node) === indexOf.get(node)) {
      const component: string[] = [];
      for (;;) {
        const member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
        if (member === node) break;
      }
      component.sort();
      components.push(component);
    }
  };

  for (const node of nodes) {
    if (!indexOf.has(node)) visit(node);
  }
  return components;
}

export function effectiveAvailable(
  online: ReadonlySet<string>,
  deps: ReadonlyMap<string, ReadonlySet<string>>,
  services: Iterable<string>,
): Set<string> {
  const nodes = collectNodes(services, deps);
  const components = stronglyConnectedComponents(nodes, deps);
  const compOf = new Map<string, number>();
  components.forEach((component, id) => {
    for (const member of component) compOf.set(member, id);
  });
  const available = new Set<string>();
  const compAvailable = new Array<boolean>(components.length).fill(false);
  components.forEach((component, id) => {
    let ok = true;
    for (const member of component) {
      if (!online.has(member)) {
        ok = false;
        break;
      }
    }
    if (ok) {
      for (const member of component) {
        for (const target of deps.get(member) ?? []) {
          const targetComp = compOf.get(target);
          if (targetComp !== undefined && targetComp !== id && !compAvailable[targetComp]) {
            ok = false;
            break;
          }
        }
        if (!ok) break;
      }
    }
    compAvailable[id] = ok;
    if (ok) {
      for (const member of component) available.add(member);
    }
  });
  return available;
}
