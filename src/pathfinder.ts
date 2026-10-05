import { CertGraph, DEFAULT_MAX_LENGTH } from "./model.js";

export interface PathRequest {
  leafId: string;
  usage: string;
  maxLength?: number;
}

export interface Failure {
  code:
    | "LEAF_NOT_FOUND"
    | "LEAF_INVALID"
    | "LEAF_USAGE_MISMATCH"
    | "NO_TRUSTED_ROOT_REACHABLE"
    | "PATH_TOO_LONG"
    | "CERT_INVALID"
    | "USAGE_MISMATCH";
  message: string;
  certId?: string;
}

export type PathResult =
  | { ok: true; path: string[] }
  | { ok: false; failure: Failure };

export function compareIdSequences(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i] as string;
    const y = b[i] as string;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return a.length - b.length;
}

function effectiveMaxLength(request: PathRequest): number {
  return request.maxLength ?? DEFAULT_MAX_LENGTH;
}

function precheck(graph: CertGraph, request: PathRequest): Failure | null {
  const leaf = graph.nodes.get(request.leafId);
  if (leaf === undefined) {
    return {
      code: "LEAF_NOT_FOUND",
      message: `leaf certificate "${request.leafId}" is not in the graph`,
      certId: request.leafId,
    };
  }
  if (graph.validity.get(request.leafId) !== true) {
    return {
      code: "LEAF_INVALID",
      message: `leaf certificate "${request.leafId}" is invalid per explicit verification results`,
      certId: request.leafId,
    };
  }
  if (!leaf.usages.includes(request.usage)) {
    return {
      code: "LEAF_USAGE_MISMATCH",
      message: `leaf certificate "${request.leafId}" does not allow usage "${request.usage}"`,
      certId: request.leafId,
    };
  }
  return null;
}

/**
 * Main search: breadth-first by path length from the leaf along issuer
 * edges, pruning invalid certificates, usage mismatches, cycles and
 * over-length paths as it goes. Within one depth level, candidate paths are
 * expanded in lexicographic id-sequence order, so the first accepted path
 * is the shortest one, ties broken by certificate id order.
 */
export function findPath(graph: CertGraph, request: PathRequest): PathResult {
  const failed = precheck(graph, request);
  if (failed !== null) return { ok: false, failure: failed };

  const maxLength = effectiveMaxLength(request);
  let frontier: string[][] = [[request.leafId]];

  while (frontier.length > 0) {
    const next: string[][] = [];
    for (const path of frontier) {
      const tip = path[path.length - 1] as string;
      if (graph.trustedRoots.has(tip)) {
        return { ok: true, path };
      }
      if (path.length >= maxLength) continue;
      const node = graph.nodes.get(tip);
      if (node === undefined) continue;
      for (const issuer of node.issuers) {
        if (path.includes(issuer)) continue; // keep paths simple (no cycles)
        if (graph.validity.get(issuer) !== true) continue;
        const issuerNode = graph.nodes.get(issuer);
        if (issuerNode === undefined || !issuerNode.usages.includes(request.usage)) continue;
        next.push([...path, issuer]);
      }
    }
    next.sort(compareIdSequences);
    frontier = next;
  }

  return { ok: false, failure: diagnose(graph, request) };
}

/**
 * Deterministic diagnosis once the search has failed: inspect the best
 * structural issuer chain to a trusted root (ignoring validity and usage)
 * and report the first constraint it violates.
 */
export function diagnose(graph: CertGraph, request: PathRequest): Failure {
  const failed = precheck(graph, request);
  if (failed !== null) return failed;

  const maxLength = effectiveMaxLength(request);
  const structural: string[][] = [];
  const stack: string[][] = [[request.leafId]];
  while (stack.length > 0) {
    const path = stack.pop() as string[];
    const tip = path[path.length - 1] as string;
    if (graph.trustedRoots.has(tip)) {
      structural.push(path);
      continue;
    }
    const node = graph.nodes.get(tip);
    if (node === undefined) continue;
    for (const issuer of node.issuers) {
      if (path.includes(issuer)) continue;
      stack.push([...path, issuer]);
    }
  }

  if (structural.length === 0) {
    return {
      code: "NO_TRUSTED_ROOT_REACHABLE",
      message: `no issuer chain from "${request.leafId}" reaches any trusted root`,
      certId: request.leafId,
    };
  }

  structural.sort((a, b) => a.length - b.length || compareIdSequences(a, b));
  const best = structural[0] as string[];

  if (best.length > maxLength) {
    return {
      code: "PATH_TOO_LONG",
      message: `shortest chain to a trusted root needs ${best.length} certificates, exceeding the maximum of ${maxLength}`,
    };
  }
  for (const id of best) {
    if (graph.validity.get(id) !== true) {
      return {
        code: "CERT_INVALID",
        message: `certificate "${id}" on the best chain is invalid per explicit verification results`,
        certId: id,
      };
    }
    const node = graph.nodes.get(id);
    if (node !== undefined && !node.usages.includes(request.usage)) {
      return {
        code: "USAGE_MISMATCH",
        message: `certificate "${id}" on the best chain does not allow usage "${request.usage}"`,
        certId: id,
      };
    }
  }
  // Every structural chain is individually acceptable yet the pruned search
  // found nothing; should be unreachable, but stay explicit.
  return {
    code: "NO_TRUSTED_ROOT_REACHABLE",
    message: `no chain from "${request.leafId}" satisfies all constraints`,
    certId: request.leafId,
  };
}
