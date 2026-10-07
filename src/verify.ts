import { edgeById, type Graph } from './graph.ts';

export interface PathStep {
  edgeId: string;
  edgeVersion: number;
}

export interface PathCertificate {
  kind: 'path';
  start: string;
  steps: PathStep[];
  totalCost: number;
}

export interface OptimalityCertificate {
  kind: 'optimality';
  source: string;
  target: string;
  path: PathCertificate;
  potentials: Record<string, number>;
}

export interface NegativeCycleCertificate {
  kind: 'negative-cycle';
  start: string;
  steps: PathStep[];
}

export type VerifyErrorCode =
  | 'unknown-node'
  | 'unknown-edge'
  | 'version-mismatch'
  | 'not-a-path'
  | 'repeated-node'
  | 'cost-mismatch'
  | 'endpoint-mismatch'
  | 'missing-potential'
  | 'triangle-inequality'
  | 'bound-not-tight'
  | 'empty-cycle'
  | 'not-a-cycle'
  | 'cycle-not-negative';

export interface VerifyFailure {
  ok: false;
  code: VerifyErrorCode;
  message: string;
  /** Index of the first failing step (or graph edge for potential checks); -1 when not positional. */
  position: number;
}

export interface VerifySuccess<T> {
  ok: true;
  value: T;
}

export type VerifyResult<T> = VerifySuccess<T> | VerifyFailure;

export interface VerifyOptions {
  /** When false (default), any node visited twice rejects the certificate. */
  allowRepeatedNodes?: boolean;
}

function fail<T>(code: VerifyErrorCode, message: string, position: number): VerifyResult<T> {
  return { ok: false, code, message, position };
}

interface WalkResult {
  end: string;
  cost: number;
}

function walk(
  graph: Graph,
  start: string,
  steps: readonly PathStep[],
  allowRepeatedNodes: boolean,
): VerifyResult<WalkResult> {
  const edges = edgeById(graph);
  const nodes = new Set(graph.nodes);
  if (!nodes.has(start)) {
    return fail('unknown-node', `start node '${start}' is not in the graph`, -1);
  }
  let current = start;
  let cost = 0;
  const visited = new Set<string>([start]);
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const edge = edges.get(step.edgeId);
    if (edge === undefined) {
      return fail('unknown-edge', `step ${i}: no edge with id '${step.edgeId}'`, i);
    }
    if (edge.version !== step.edgeVersion) {
      return fail(
        'version-mismatch',
        `step ${i}: edge '${edge.id}' is at version ${edge.version}, certificate claims ${step.edgeVersion}`,
        i,
      );
    }
    if (edge.from !== current) {
      return fail(
        'not-a-path',
        `step ${i}: edge '${edge.id}' leaves '${edge.from}', but the walk is at '${current}'`,
        i,
      );
    }
    if (!allowRepeatedNodes && visited.has(edge.to)) {
      return fail('repeated-node', `step ${i}: node '${edge.to}' is visited more than once`, i);
    }
    visited.add(edge.to);
    cost += edge.cost;
    current = edge.to;
  }
  return { ok: true, value: { end: current, cost } };
}

export function verifyPath(
  graph: Graph,
  cert: PathCertificate,
  options: VerifyOptions = {},
): VerifyResult<WalkResult> {
  const walked = walk(graph, cert.start, cert.steps, options.allowRepeatedNodes ?? false);
  if (!walked.ok) {
    return walked;
  }
  if (walked.value.cost !== cert.totalCost) {
    return fail(
      'cost-mismatch',
      `declared totalCost is ${cert.totalCost}, but the steps sum to ${walked.value.cost}`,
      -1,
    );
  }
  return walked;
}

export function verifyOptimality(
  graph: Graph,
  cert: OptimalityCertificate,
  options: VerifyOptions = {},
): VerifyResult<{ cost: number }> {
  if (cert.path.start !== cert.source) {
    return fail(
      'endpoint-mismatch',
      `certificate source is '${cert.source}' but the path starts at '${cert.path.start}'`,
      -1,
    );
  }
  const walked = verifyPath(graph, cert.path, options);
  if (!walked.ok) {
    return walked;
  }
  if (walked.value.end !== cert.target) {
    return fail(
      'endpoint-mismatch',
      `certificate target is '${cert.target}' but the path ends at '${walked.value.end}'`,
      -1,
    );
  }
  const potentials = cert.potentials;
  const sourcePotential = potentials[cert.source];
  const targetPotential = potentials[cert.target];
  if (typeof sourcePotential !== 'number' || !Number.isFinite(sourcePotential)) {
    return fail('missing-potential', `no finite potential for source '${cert.source}'`, -1);
  }
  if (typeof targetPotential !== 'number' || !Number.isFinite(targetPotential)) {
    return fail('missing-potential', `no finite potential for target '${cert.target}'`, -1);
  }
  for (let i = 0; i < graph.edges.length; i++) {
    const edge = graph.edges[i];
    const from = potentials[edge.from];
    const to = potentials[edge.to];
    if (typeof from !== 'number' || !Number.isFinite(from)) {
      return fail('missing-potential', `no finite potential for node '${edge.from}'`, i);
    }
    if (typeof to !== 'number' || !Number.isFinite(to)) {
      return fail('missing-potential', `no finite potential for node '${edge.to}'`, i);
    }
    if (to > from + edge.cost) {
      return fail(
        'triangle-inequality',
        `edge '${edge.id}' (index ${i}) violates potential['${edge.to}'] (${to}) <= potential['${edge.from}'] (${from}) + cost (${edge.cost})`,
        i,
      );
    }
  }
  if (cert.path.totalCost !== targetPotential - sourcePotential) {
    return fail(
      'bound-not-tight',
      `path cost ${cert.path.totalCost} does not reach the lower bound potential['${cert.target}'] - potential['${cert.source}'] = ${targetPotential - sourcePotential}`,
      -1,
    );
  }
  return { ok: true, value: { cost: walked.value.cost } };
}

export function verifyNegativeCycle(
  graph: Graph,
  cert: NegativeCycleCertificate,
): VerifyResult<{ cost: number }> {
  if (cert.steps.length === 0) {
    return fail('empty-cycle', 'a negative-cycle certificate needs at least one step', -1);
  }
  const walked = walk(graph, cert.start, cert.steps, true);
  if (!walked.ok) {
    return walked;
  }
  if (walked.value.end !== cert.start) {
    return fail(
      'not-a-cycle',
      `walk starts at '${cert.start}' but ends at '${walked.value.end}'`,
      -1,
    );
  }
  if (walked.value.cost >= 0) {
    return fail('cycle-not-negative', `cycle cost is ${walked.value.cost}, expected < 0`, -1);
  }
  return { ok: true, value: { cost: walked.value.cost } };
}
