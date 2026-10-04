'use strict';

const {
  normalizeGraph,
  graphVersion,
  bfsReachable,
  bfsPath,
  buildReverseAdjacency,
} = require('./graph.js');
const {
  edgeHash,
  reachChainRoot,
  setHash,
  boundaryHash,
  checkIntegrity,
  makeReachCert,
  makeNonreachCert,
} = require('./cert.js');

const VALID = 'VALID';
const CERT_INVALID = 'CERT_INVALID';
const NO_SUCH_NODE = 'NO_SUCH_NODE';
const VERSION_MISMATCH = 'VERSION_MISMATCH';

function build(nodes, edges) {
  const graph = normalizeGraph(nodes, edges);
  return { version: graphVersion(graph), graph, registry: [] };
}

function hasNode(store, n) {
  return store.graph.nodes.includes(n);
}

function prove_reach(store, s, t, opts = {}) {
  s = String(s);
  t = String(t);
  if (!hasNode(store, s) || !hasNode(store, t)) {
    return { ok: false, code: NO_SUCH_NODE };
  }
  const path = bfsPath(store.graph, s, t);
  if (path === null) {
    return { ok: false, code: 'UNREACHABLE' };
  }
  const now = opts.now ?? Date.now();
  const cert = makeReachCert(store.version, s, t, path, now, opts.ttlMs);
  if (store.registry.includes(cert.proof_id)) {
    return { ok: false, code: 'DUPLICATE_PROOF_ID' };
  }
  store.registry.push(cert.proof_id);
  return { ok: true, cert };
}

function prove_nonreach(store, s, t, opts = {}) {
  s = String(s);
  t = String(t);
  if (!hasNode(store, s) || !hasNode(store, t)) {
    return { ok: false, code: NO_SUCH_NODE };
  }
  const reachable = bfsReachable(store.graph, s);
  if (reachable.has(t)) {
    return { ok: false, code: 'REACHABLE' };
  }
  const boundary = store.graph.edges.filter((e) => reachable.has(e.from));
  const now = opts.now ?? Date.now();
  const cert = makeNonreachCert(store.version, s, t, reachable, boundary, now, opts.ttlMs);
  if (store.registry.includes(cert.proof_id)) {
    return { ok: false, code: 'DUPLICATE_PROOF_ID' };
  }
  store.registry.push(cert.proof_id);
  return { ok: true, cert };
}

function verify(store, proof, opts = {}) {
  if (!checkIntegrity(proof)) return CERT_INVALID;
  if (proof.version !== store.version) return VERSION_MISMATCH;
  const s = String(proof.s);
  const t = String(proof.t);
  if (!hasNode(store, s) || !hasNode(store, t)) return NO_SUCH_NODE;
  const now = opts.now ?? Date.now();
  if (typeof proof.expires_at !== 'number' || now > proof.expires_at) return CERT_INVALID;
  if (!store.registry.includes(proof.proof_id)) return CERT_INVALID;
  if (proof.kind === 'reach') return verifyReach(store, proof, s, t);
  if (proof.kind === 'nonreach') return verifyNonreach(store, proof, s, t);
  return CERT_INVALID;
}

function verifyReach(store, proof, s, t) {
  const path = proof.path;
  if (!Array.isArray(path) || path.length === 0) return CERT_INVALID;
  if (path[0] !== s || path[path.length - 1] !== t) return CERT_INVALID;
  if (!Array.isArray(proof.edge_hashes) || proof.edge_hashes.length !== path.length - 1) {
    return CERT_INVALID;
  }
  const edgeSet = new Set(store.graph.edges.map((e) => e.from + '->' + e.to));
  for (let i = 0; i + 1 < path.length; i += 1) {
    if (!edgeSet.has(path[i] + '->' + path[i + 1])) return CERT_INVALID;
    if (proof.edge_hashes[i] !== edgeHash(store.version, path[i], path[i + 1])) {
      return CERT_INVALID;
    }
  }
  if (proof.chain_root !== reachChainRoot(store.version, s, t, path)) return CERT_INVALID;
  return VALID;
}

function verifyNonreach(store, proof, s, t) {
  if (!Array.isArray(proof.reachable_set) || !Array.isArray(proof.boundary)) {
    return CERT_INVALID;
  }
  const claimed = [...proof.reachable_set].map(String).sort();
  if (claimed.includes(t)) return CERT_INVALID;
  const actual = [...bfsReachable(store.graph, s)].sort();
  if (claimed.length !== actual.length || claimed.some((n, i) => n !== actual[i])) {
    return CERT_INVALID;
  }
  const reachSet = new Set(actual);
  const actualBoundary = store.graph.edges
    .filter((e) => reachSet.has(e.from))
    .map((e) => e.from + '->' + e.to)
    .sort();
  const claimedBoundary = proof.boundary
    .map((e) => String(e.from) + '->' + String(e.to))
    .sort();
  if (claimedBoundary.length !== actualBoundary.length
      || claimedBoundary.some((e, i) => e !== actualBoundary[i])) {
    return CERT_INVALID;
  }
  if (proof.set_hash !== setHash(store.version, actual)) return CERT_INVALID;
  const boundaryObjs = actualBoundary.map((e) => {
    const [from, to] = e.split('->');
    return { from, to };
  });
  if (proof.boundary_hash !== boundaryHash(store.version, boundaryObjs)) return CERT_INVALID;
  return VALID;
}

function locate_contamination(store, sources, t) {
  t = String(t);
  const srcs = sources.map(String);
  if (!hasNode(store, t) || srcs.some((s) => !hasNode(store, s))) {
    return { ok: false, code: NO_SUCH_NODE };
  }
  const srcSet = new Set(srcs);
  if (srcSet.has(t)) {
    return { ok: true, source: t, path: [t], first_edge: null };
  }
  const rev = buildReverseAdjacency(store.graph);
  const parent = new Map([[t, null]]);
  const queue = [t];
  let hit = null;
  while (queue.length > 0 && hit === null) {
    const u = queue.shift();
    for (const v of rev.get(u) || []) {
      if (!parent.has(v)) {
        parent.set(v, u);
        if (srcSet.has(v)) {
          hit = v;
          break;
        }
        queue.push(v);
      }
    }
  }
  if (hit === null) return { ok: false, code: 'NO_CONTAMINATION' };
  const path = [hit];
  let cur = parent.get(hit);
  while (cur !== null) {
    path.push(cur);
    cur = parent.get(cur);
  }
  const firstEdge = path.length > 1 ? { from: path[0], to: path[1] } : null;
  return { ok: true, source: hit, path, first_edge: firstEdge };
}

module.exports = {
  build,
  prove_reach,
  prove_nonreach,
  verify,
  locate_contamination,
  VALID,
  CERT_INVALID,
  NO_SUCH_NODE,
  VERSION_MISMATCH,
};
