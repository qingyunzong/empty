import type { VersionGraph } from "./graph";

/**
 * 暴力参考模型：对每个节点独立 DFS 求全可达祖先集合（含自身），
 * 用于在小 DAG 上核对库实现。与库实现不共享任何代码路径。
 */
export function fullReachability(
  graph: VersionGraph,
): Map<string, Set<string>> {
  const reachability = new Map<string, Set<string>>();
  for (const id of graph.commits()) {
    const reachable = new Set<string>([id]);
    const stack = [id];
    while (stack.length > 0) {
      const node = stack.pop()!;
      for (const parent of graph.getParents(node)) {
        if (!reachable.has(parent)) {
          reachable.add(parent);
          stack.push(parent);
        }
      }
    }
    reachability.set(id, reachable);
  }
  return reachability;
}

/** 模型版 merge bases：先求交集，再剔除"是另一共同祖先真祖先"者。 */
export function modelMergeBases(
  graph: VersionGraph,
  queries: readonly string[],
): string[] {
  if (queries.length === 0) return [];
  const reachability = fullReachability(graph);
  const common = [...reachability.get(queries[0]!)!].filter((candidate) =>
    queries.every((query) => reachability.get(query)!.has(candidate)),
  );
  return common
    .filter(
      (candidate) =>
        !common.some(
          (other) =>
            other !== candidate && reachability.get(other)!.has(candidate),
        ),
    )
    .sort();
}
