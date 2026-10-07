import {
  sha256hex,
  canonEdge,
  reachableSet,
  shortestPath,
  boundaryEdges,
  DEFAULT_MAX_STEPS,
  NoSuchNodeError,
  NoPathError,
  PathExistsError,
} from './graph.js';

export const VERDICT = Object.freeze({
  VALID: 'VALID',
  CERT_INVALID: 'CERT_INVALID',
  NO_SUCH_NODE: 'NO_SUCH_NODE',
  VERSION_MISMATCH: 'VERSION_MISMATCH',
});

const PROOF_SCHEMA_VERSION = 'proof-v1';

function computeProofId(type, version, s, t, bodyHash) {
  return sha256hex(
    [PROOF_SCHEMA_VERSION, type, version, JSON.stringify(s), JSON.stringify(t), bodyHash].join('\n')
  );
}

function pathEdges(path) {
  const edges = [];
  for (let i = 0; i + 1 < path.length; i++) edges.push([path[i], path[i + 1]]);
  return edges;
}

function reachChain(version, s, edges) {
  const chain = [sha256hex(['reach-chain', version, JSON.stringify(s)].join('\n'))];
  for (const e of edges) {
    chain.push(sha256hex(chain[chain.length - 1] + '\n' + canonEdge(e)));
  }
  return chain;
}

function setHash(version, members) {
  return sha256hex(['reach-set', version, ...members].join('\n'));
}

function boundaryHash(version, edges) {
  return sha256hex(['boundary', version, ...edges.map(canonEdge)].join('\n'));
}

/**
 * Reachability certificate: the path plus a per-edge hash chain anchored in
 * the graph version. Any altered, reordered, or missing layer breaks the chain.
 */
export function proveReach(graph, s, t, maxSteps = DEFAULT_MAX_STEPS) {
  const path = shortestPath(graph, s, t, maxSteps);
  if (path === null) throw new NoPathError(s, t);
  const edges = pathEdges(path);
  const chain = reachChain(graph.version, s, edges);
  const bodyHash = sha256hex(
    ['reach-body', JSON.stringify(path), JSON.stringify(chain)].join('\n')
  );
  return {
    schema: PROOF_SCHEMA_VERSION,
    type: 'reach',
    proofId: computeProofId('reach', graph.version, s, t, bodyHash),
    version: graph.version,
    s,
    t,
    path,
    edges,
    chain,
    bodyHash,
  };
}

/**
 * Non-reachability certificate: the exact BFS reachable set from s (closed
 * under graph edges) plus the full boundary edge list. t must be outside.
 */
export function proveNonreach(graph, s, t, maxSteps = DEFAULT_MAX_STEPS) {
  if (!graph.nodeSet.has(s)) throw new NoSuchNodeError(s);
  if (!graph.nodeSet.has(t)) throw new NoSuchNodeError(t);
  const reach = reachableSet(graph, s, maxSteps);
  if (reach.has(t)) throw new PathExistsError(s, t);
  const reachable = [...reach].sort();
  const boundary = boundaryEdges(graph, reach);
  const rHash = setHash(graph.version, reachable);
  const bHash = boundaryHash(graph.version, boundary);
  const bodyHash = sha256hex(['nonreach-body', rHash, bHash].join('\n'));
  return {
    schema: PROOF_SCHEMA_VERSION,
    type: 'nonreach',
    proofId: computeProofId('nonreach', graph.version, s, t, bodyHash),
    version: graph.version,
    s,
    t,
    reachable,
    boundary,
    reachableHash: rHash,
    boundaryHash: bHash,
    bodyHash,
  };
}

function isStrArray(x) {
  return Array.isArray(x) && x.every((v) => typeof v === 'string');
}

function isEdgeArray(x) {
  return (
    Array.isArray(x) &&
    x.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && typeof e[1] === 'string')
  );
}

function verifyReach(graph, proof) {
  const { path, edges, chain, s, t, version } = proof;
  if (!isStrArray(path) || !isEdgeArray(edges) || !isStrArray(chain)) return VERDICT.CERT_INVALID;
  if (path.length === 0) return VERDICT.CERT_INVALID;
  if (path[0] !== s || path[path.length - 1] !== t) return VERDICT.CERT_INVALID;
  if (edges.length !== path.length - 1) return VERDICT.CERT_INVALID;
  if (chain.length !== edges.length + 1) return VERDICT.CERT_INVALID; // missing layer
  const edgeSet = new Set(graph.edges.map(canonEdge));
  for (let i = 0; i < edges.length; i++) {
    if (edges[i][0] !== path[i] || edges[i][1] !== path[i + 1]) return VERDICT.CERT_INVALID;
    if (!edgeSet.has(canonEdge(edges[i]))) return VERDICT.CERT_INVALID; // fake edge
  }
  const expected = reachChain(version, s, edges);
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== chain[i]) return VERDICT.CERT_INVALID;
  }
  const bodyHash = sha256hex(['reach-body', JSON.stringify(path), JSON.stringify(chain)].join('\n'));
  if (bodyHash !== proof.bodyHash) return VERDICT.CERT_INVALID;
  if (computeProofId('reach', version, s, t, bodyHash) !== proof.proofId) return VERDICT.CERT_INVALID;
  return VERDICT.VALID;
}

function verifyNonreach(graph, proof, maxSteps) {
  const { reachable, boundary, s, t, version } = proof;
  if (!isStrArray(reachable) || !isEdgeArray(boundary)) return VERDICT.CERT_INVALID;
  // Recompute ground truth from the versioned graph.
  let actual;
  try {
    actual = reachableSet(graph, s, maxSteps);
  } catch (err) {
    if (err && err.code === 'PROVE_TIMEOUT') return VERDICT.CERT_INVALID;
    throw err;
  }
  const expectedReachable = [...actual].sort();
  if (reachable.length !== expectedReachable.length) return VERDICT.CERT_INVALID;
  for (let i = 0; i < reachable.length; i++) {
    if (reachable[i] !== expectedReachable[i]) return VERDICT.CERT_INVALID;
  }
  if (actual.has(t)) return VERDICT.CERT_INVALID; // claimed non-reach, but reachable
  const expectedBoundary = boundaryEdges(graph, actual);
  if (boundary.length !== expectedBoundary.length) return VERDICT.CERT_INVALID; // missing boundary layer
  for (let i = 0; i < boundary.length; i++) {
    if (canonEdge(boundary[i]) !== canonEdge(expectedBoundary[i])) return VERDICT.CERT_INVALID;
  }
  if (setHash(version, reachable) !== proof.reachableHash) return VERDICT.CERT_INVALID;
  if (boundaryHash(version, boundary) !== proof.boundaryHash) return VERDICT.CERT_INVALID;
  const bodyHash = sha256hex(['nonreach-body', proof.reachableHash, proof.boundaryHash].join('\n'));
  if (bodyHash !== proof.bodyHash) return VERDICT.CERT_INVALID;
  if (computeProofId('nonreach', version, s, t, bodyHash) !== proof.proofId) return VERDICT.CERT_INVALID;
  return VERDICT.VALID;
}

/**
 * Verify a certificate against a versioned graph snapshot.
 * Returns one of VALID | CERT_INVALID | NO_SUCH_NODE | VERSION_MISMATCH.
 * Never returns NO_PATH: an exhausted budget is CERT_INVALID, not absence of a path.
 */
export function verify(graph, proof, maxSteps = DEFAULT_MAX_STEPS) {
  if (proof === null || typeof proof !== 'object' || Array.isArray(proof)) return VERDICT.CERT_INVALID;
  if (proof.schema !== PROOF_SCHEMA_VERSION) return VERDICT.CERT_INVALID;
  if (proof.type !== 'reach' && proof.type !== 'nonreach') return VERDICT.CERT_INVALID;
  if (typeof proof.s !== 'string' || typeof proof.t !== 'string') return VERDICT.CERT_INVALID;
  if (typeof proof.version !== 'string') return VERDICT.CERT_INVALID;
  if (proof.version !== graph.version) return VERDICT.VERSION_MISMATCH; // stale / expired cert
  if (!graph.nodeSet.has(proof.s) || !graph.nodeSet.has(proof.t)) return VERDICT.NO_SUCH_NODE;
  return proof.type === 'reach'
    ? verifyReach(graph, proof)
    : verifyNonreach(graph, proof, maxSteps);
}
