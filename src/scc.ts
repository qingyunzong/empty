/** Tarjan 强连通分量，用于发现循环依赖组件。 */

export interface SccResult {
  /** 每个分量是服务 id 数组；按依赖拓扑序排列（被依赖者在前）。 */
  components: string[][];
  /** service -> 分量下标 */
  indexOf: Map<string, number>;
}

export function stronglyConnectedComponents(
  nodes: readonly string[],
  deps: (s: string) => Iterable<string>,
): SccResult {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  function visit(v: string): void {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of deps(v)) {
      if (!index.has(w)) {
        visit(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }
    if (lowlink.get(v) === index.get(v)) {
      const comp: string[] = [];
      for (;;) {
        const w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
        if (w === v) break;
      }
      components.push(comp);
    }
  }

  for (const n of nodes) {
    if (!index.has(n)) visit(n);
  }

  // Tarjan 产出的分量顺序即“被依赖者在前”的逆拓扑序。
  const indexOf = new Map<string, number>();
  components.forEach((comp, i) => {
    for (const s of comp) indexOf.set(s, i);
  });
  return { components, indexOf };
}
