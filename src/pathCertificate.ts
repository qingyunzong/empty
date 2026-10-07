import type { Graph } from "./graph.js";

/** One hop of a certified path: an edge id pinned to the version seen at proving time. */
export interface PathStep {
  readonly edgeId: string;
  readonly version: number;
}

export interface PathCertificate {
  readonly source: string;
  readonly target: string;
  readonly steps: readonly PathStep[];
  readonly totalCost: number;
}

export interface PathVerifyOptions {
  /** When false (default), any repeated node on the path is rejected. */
  readonly allowRepeatedNodes?: boolean;
}

export type VerifyFailure = {
  readonly ok: false;
  /**
   * Index of the first step where verification fails. Terminal mismatches
   * (wrong target, wrong total cost) are reported at position `steps.length`.
   */
  readonly position: number;
  readonly reason: string;
};

export type VerifyResult = { readonly ok: true } | VerifyFailure;

const fail = (position: number, reason: string): VerifyFailure => ({
  ok: false,
  position,
  reason,
});

export function generatePathCertificate(
  graph: Graph,
  source: string,
  target: string,
  edgeIds: readonly string[],
): PathCertificate {
  const steps: PathStep[] = [];
  let current = source;
  let totalCost = 0;
  for (const edgeId of edgeIds) {
    const edge = graph.getEdge(edgeId);
    if (edge === undefined) throw new Error(`unknown edge: ${edgeId}`);
    if (edge.from !== current) {
      throw new Error(`edge ${edgeId} does not start at ${current}`);
    }
    steps.push({ edgeId: edge.id, version: edge.version });
    totalCost += edge.weight;
    current = edge.to;
  }
  if (current !== target) {
    throw new Error(`path ends at ${current}, not ${target}`);
  }
  return { source, target, steps, totalCost };
}

export function verifyPathCertificate(
  graph: Graph,
  cert: PathCertificate,
  options: PathVerifyOptions = {},
): VerifyResult {
  const allowRepeatedNodes = options.allowRepeatedNodes ?? false;
  const { source, target, steps, totalCost } = cert;

  if (steps.length === 0) {
    if (source !== target) {
      return fail(0, `empty path cannot connect ${source} to ${target}`);
    }
    if (totalCost !== 0) {
      return fail(0, `empty path must have zero cost, got ${totalCost}`);
    }
    return { ok: true };
  }

  const visited = new Set<string>([source]);
  let current = source;
  let cost = 0;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const edge = graph.getEdge(step.edgeId);
    if (edge === undefined) {
      return fail(i, `unknown edge: ${step.edgeId}`);
    }
    if (edge.version !== step.version) {
      return fail(
        i,
        `edge ${edge.id} version mismatch: certificate pins ${step.version}, graph has ${edge.version}`,
      );
    }
    if (edge.from !== current) {
      return fail(i, `edge ${edge.id} starts at ${edge.from}, expected ${current}`);
    }
    if (!allowRepeatedNodes && visited.has(edge.to)) {
      return fail(i, `node ${edge.to} is repeated on the path`);
    }
    visited.add(edge.to);
    cost += edge.weight;
    current = edge.to;
  }

  if (current !== target) {
    return fail(steps.length, `path ends at ${current}, not ${target}`);
  }
  if (cost !== totalCost) {
    return fail(steps.length, `declared cost ${totalCost} does not match actual cost ${cost}`);
  }
  return { ok: true };
}
