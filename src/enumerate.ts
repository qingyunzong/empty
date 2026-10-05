import { CertGraph, DEFAULT_MAX_LENGTH } from "./model.js";
import {
  compareIdSequences,
  diagnose,
  PathRequest,
  PathResult,
} from "./pathfinder.js";

/**
 * Reference implementation used to cross-check the pruned search: enumerate
 * every simple issuer chain from the leaf (no constraint pruning during
 * enumeration), keep the ones that satisfy all constraints, then pick the
 * shortest with ties broken by certificate id order.
 */
export function enumerateSimplePaths(
  graph: CertGraph,
  leafId: string,
  maxLength: number = DEFAULT_MAX_LENGTH,
): string[][] {
  const results: string[][] = [];
  const stack: string[][] = [[leafId]];
  while (stack.length > 0) {
    const path = stack.pop() as string[];
    const tip = path[path.length - 1] as string;
    if (graph.trustedRoots.has(tip)) {
      results.push(path);
      continue; // a chain ends at its trust anchor
    }
    if (path.length >= maxLength) continue;
    const node = graph.nodes.get(tip);
    if (node === undefined) continue;
    for (const issuer of node.issuers) {
      if (path.includes(issuer)) continue;
      stack.push([...path, issuer]);
    }
  }
  return results;
}

export function findPathByEnumeration(
  graph: CertGraph,
  request: PathRequest,
): PathResult {
  if (!graph.nodes.has(request.leafId)) {
    return { ok: false, failure: diagnose(graph, request) };
  }
  const maxLength = request.maxLength ?? DEFAULT_MAX_LENGTH;
  const candidates = enumerateSimplePaths(graph, request.leafId, maxLength).filter(
    (path) =>
      path.every((id) => graph.validity.get(id) === true) &&
      path.every((id) => {
        const node = graph.nodes.get(id);
        return node !== undefined && node.usages.includes(request.usage);
      }),
  );
  if (candidates.length === 0) {
    return { ok: false, failure: diagnose(graph, request) };
  }
  candidates.sort((a, b) => a.length - b.length || compareIdSequences(a, b));
  return { ok: true, path: candidates[0] as string[] };
}
