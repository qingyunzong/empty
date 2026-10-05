import { CertGraph, CertificateNode } from "../src/model.js";

export function makeGraph(
  certs: Array<[string, string[], string[]]>,
  validity: Record<string, boolean>,
  trustedRoots: string[],
): CertGraph {
  const nodes = new Map<string, CertificateNode>();
  for (const [id, issuers, usages] of certs) {
    nodes.set(id, { id, issuers, usages });
  }
  return {
    nodes,
    validity: new Map(Object.entries(validity)),
    trustedRoots: new Set(trustedRoots),
  };
}

/** Deterministic PRNG (LCG) so randomized cross-checks are reproducible. */
export function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
