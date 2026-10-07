import { UnknownCommitError, type VersionGraph } from "./graph";
import { lowestCommonAncestors } from "./lca";

/**
 * 祖先关系证书：一条从 ancestor 到 descendant 的有向路径，
 * 路径上相邻两点 (u, v) 满足 v 的父提交列表包含 u。
 * 验证者只需逐边核对，无需全图遍历。
 */
export interface AncestorCertificate {
  kind: "ancestor";
  ancestor: string;
  descendant: string;
  path: string[];
}

/** 为祖先关系签发证书；ancestor 不是 descendant 的祖先时返回 null。 */
export function issueAncestorCertificate(
  graph: VersionGraph,
  ancestor: string,
  descendant: string,
): AncestorCertificate | null {
  if (!graph.has(ancestor)) throw new UnknownCommitError(`unknown commit: ${ancestor}`);
  if (!graph.has(descendant)) throw new UnknownCommitError(`unknown commit: ${descendant}`);
  // 自 descendant 沿父边 BFS，记录 nextHop：父 -> 子（朝 descendant 方向）。
  const nextHop = new Map<string, string>();
  const queue = [descendant];
  const visited = new Set<string>([descendant]);
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node === ancestor) break;
    for (const parent of graph.getParents(node)) {
      if (!visited.has(parent)) {
        visited.add(parent);
        nextHop.set(parent, node);
        queue.push(parent);
      }
    }
  }
  if (!visited.has(ancestor)) return null;
  const path = [ancestor];
  while (path[path.length - 1] !== descendant) {
    path.push(nextHop.get(path[path.length - 1]!)!);
  }
  return { kind: "ancestor", ancestor, descendant, path };
}

/** 逐边核对证书路径；任何一步不成立或端点不符即拒绝。 */
export function verifyAncestorCertificate(
  graph: VersionGraph,
  cert: AncestorCertificate,
): boolean {
  const { ancestor, descendant, path } = cert;
  if (path.length === 0) return false;
  if (path[0] !== ancestor || path[path.length - 1] !== descendant) return false;
  try {
    for (let i = 1; i < path.length; i++) {
      if (!graph.getParents(path[i]!).includes(path[i - 1]!)) return false;
    }
  } catch {
    return false;
  }
  return true;
}

/**
 * 合并基点证书：对每个基点，给出它到每个查询基点的祖先路径。
 * 证明"每个基点都是全部查询点的共同祖先"；
 * 基点集合的完备性与极大性由模型核对（见 test/model.test.ts）。
 */
export interface MergeBaseCertificate {
  kind: "merge-bases";
  queries: string[];
  bases: { base: string; paths: Record<string, string[]> }[];
}

export function issueMergeBaseCertificate(
  graph: VersionGraph,
  queries: readonly string[],
): MergeBaseCertificate {
  const bases = lowestCommonAncestors(graph, queries);
  return {
    kind: "merge-bases",
    queries: [...queries],
    bases: bases.map((base) => ({
      base,
      paths: Object.fromEntries(
        queries.map((query) => [
          query,
          issueAncestorCertificate(graph, base, query)!.path,
        ]),
      ),
    })),
  };
}

export function verifyMergeBaseCertificate(
  graph: VersionGraph,
  cert: MergeBaseCertificate,
): boolean {
  for (const { base, paths } of cert.bases) {
    for (const query of cert.queries) {
      const path = paths[query];
      if (!path) return false;
      const ok = verifyAncestorCertificate(graph, {
        kind: "ancestor",
        ancestor: base,
        descendant: query,
        path,
      });
      if (!ok) return false;
    }
  }
  return true;
}
