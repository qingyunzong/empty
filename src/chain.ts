import { CertNode, Graph, VerifyRequest, MAX_CHAIN_LENGTH } from "./types";
import { issuersOf } from "./graph";

export interface PathFailure {
  path: string[];
  reasons: string[];
}

export interface VerifyResult {
  ok: boolean;
  chain: string[] | null;
  failures: PathFailure[];
  crossCheck: { method: string; chain: string[] | null; agree: boolean };
}

function indexById(graph: Graph): Map<string, CertNode> {
  return new Map(graph.certs.map((c) => [c.id, c]));
}

/** Compare two id sequences lexicographically, element by element. */
export function compareIdSeq(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return a.length - b.length;
}

/** Ordering rule: shorter chain first, then id-sequence order. */
export function betterChain(a: string[], b: string[]): string[] {
  if (a.length !== b.length) return a.length < b.length ? a : b;
  return compareIdSeq(a, b) <= 0 ? a : b;
}

/** Validate one candidate path; returns human-readable failure reasons ([] = valid). */
export function evaluatePath(
  path: string[],
  byId: Map<string, CertNode>,
  trusted: Set<string>,
  req: VerifyRequest,
): string[] {
  const reasons: string[] = [];
  if (path.length > MAX_CHAIN_LENGTH)
    reasons.push(`chain length ${path.length} exceeds max ${MAX_CHAIN_LENGTH}`);

  const at = Date.parse(req.at);
  for (const id of path) {
    const cert = byId.get(id)!;
    if (at < Date.parse(cert.notBefore))
      reasons.push(`cert ${id} not valid before ${cert.notBefore}`);
    if (at > Date.parse(cert.notAfter))
      reasons.push(`cert ${id} expired at ${cert.notAfter}`);
  }

  const usageOk = path.every((id) => byId.get(id)!.usages.includes(req.usage));
  if (!usageOk) {
    const missing = path.filter(
      (id) => !byId.get(id)!.usages.includes(req.usage),
    );
    reasons.push(
      `usage "${req.usage}" not in chain usage intersection (missing in: ${missing.join(", ")})`,
    );
  }

  const root = path[path.length - 1]!;
  if (!trusted.has(root)) reasons.push(`root ${root} is not trusted`);
  return reasons;
}

/**
 * Enumerate every simple path (no repeated certs) from the leaf along issuer
 * edges, capped at MAX_CHAIN_LENGTH. Each returned entry is a maximal path:
 * it ends at a self-signed/root cert or at the depth cap.
 */
export function enumeratePaths(
  graph: Graph,
  leaf: string,
): { paths: string[][]; truncated: string[][] } {
  const byId = indexById(graph);
  const paths: string[][] = [];
  const truncated: string[][] = [];

  const walk = (path: string[]): void => {
    const cur = byId.get(path[path.length - 1]!);
    const nexts = cur
      ? issuersOf(cur).filter((i) => i !== cur.id && !path.includes(i))
      : [];
    if (!cur || nexts.length === 0) {
      paths.push(path);
      return;
    }
    if (path.length >= MAX_CHAIN_LENGTH) {
      truncated.push(path);
      return;
    }
    for (const iss of nexts) walk([...path, iss]);
  };

  if (byId.has(leaf)) walk([leaf]);
  return { paths, truncated };
}

/**
 * Primary selection: BFS layer by layer (shortest first), id-sequence order
 * as tie-break, first fully valid chain wins.
 */
export function selectChain(graph: Graph, req: VerifyRequest): string[] | null {
  const byId = indexById(graph);
  const trusted = new Set(graph.trustedRoots);
  if (!byId.has(req.leaf)) return null;

  let frontier: string[][] = [[req.leaf]];
  while (frontier.length > 0) {
    frontier.sort(compareIdSeq);
    const next: string[][] = [];
    for (const path of frontier) {
      if (evaluatePath(path, byId, trusted, req).length === 0) return path;
      const cur = byId.get(path[path.length - 1]!)!;
      if (path.length < MAX_CHAIN_LENGTH) {
        for (const iss of issuersOf(cur)) {
          if (iss !== cur.id && !path.includes(iss)) next.push([...path, iss]);
        }
      }
    }
    frontier = next;
  }
  return null;
}

/** Cross-check: pick the best valid chain out of the full simple-path enumeration. */
export function selectChainByEnumeration(
  graph: Graph,
  req: VerifyRequest,
): string[] | null {
  const byId = indexById(graph);
  const trusted = new Set(graph.trustedRoots);
  const { paths } = enumeratePaths(graph, req.leaf);
  let best: string[] | null = null;
  for (const path of paths) {
    if (evaluatePath(path, byId, trusted, req).length !== 0) continue;
    best = best === null ? path : betterChain(path, best);
  }
  return best;
}

export function verify(graph: Graph, req: VerifyRequest): VerifyResult {
  const byId = indexById(graph);
  const trusted = new Set(graph.trustedRoots);

  const chain = selectChain(graph, req);
  const crossChain = selectChainByEnumeration(graph, req);
  const agree =
    chain === null || crossChain === null
      ? chain === crossChain
      : compareIdSeq(chain, crossChain) === 0 && chain.length === crossChain.length;

  const failures: PathFailure[] = [];
  if (chain === null) {
    if (!byId.has(req.leaf)) {
      failures.push({ path: [], reasons: [`unknown leaf cert: ${req.leaf}`] });
    } else {
      const { paths, truncated } = enumeratePaths(graph, req.leaf);
      for (const path of paths) {
        const reasons = evaluatePath(path, byId, trusted, req);
        if (reasons.length > 0) failures.push({ path, reasons });
      }
      for (const path of truncated) {
        failures.push({
          path,
          reasons: [
            `chain would exceed max ${MAX_CHAIN_LENGTH} certs (truncated at depth cap)`,
          ],
        });
      }
      if (failures.length === 0)
        failures.push({ path: [], reasons: ["no path from leaf to any root"] });
    }
  }

  return {
    ok: chain !== null,
    chain,
    failures,
    crossCheck: { method: "simple-path-enumeration", chain: crossChain, agree },
  };
}
