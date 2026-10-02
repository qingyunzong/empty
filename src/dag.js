// repro-dag: causal DAG for experiment reproduction.
// Nodes are experiment steps. Edges are data dependencies (dep -> dependent).
// Run cache keys mix code version, input hash and the full ancestor vector,
// so correcting a step invalidates exactly its descendants, nothing else.
// Evidence certificates are hash-chain segments verifiable from roots to leaves.
// Deletion is a tombstone; gc only collects tombstones every runner confirms
// are unreachable.

import { createHash } from 'node:crypto';

export class DagError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DagError';
    this.code = code;
  }
}

export const ERR = {
  CYCLE: 'CYCLE',
  MISSING_INPUT: 'MISSING_INPUT',
  BAD_CERT: 'BAD_CERT',
};

const GENESIS = 'GENESIS';

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function createStore() {
  return { nodes: {}, cache: {}, runners: [] };
}

export function serialize(store) {
  return JSON.stringify(store, null, 2);
}

export function deserialize(text) {
  const store = JSON.parse(text);
  store.nodes ??= {};
  store.cache ??= {};
  store.runners ??= [];
  return store;
}

function liveNodes(store) {
  return Object.values(store.nodes).filter((n) => !n.tombstone);
}

// Record lookup that sees tombstoned nodes: certificate chains and cache
// keys must keep resolving deleted ancestors until gc collects them.
function rawNode(store, id) {
  const node = store.nodes[id];
  if (!node) throw new DagError(ERR.MISSING_INPUT, `unknown node: ${id}`);
  return node;
}

// Live-only lookup for user-facing targets.
function liveNode(store, id) {
  const node = rawNode(store, id);
  if (node.tombstone) {
    throw new DagError(ERR.MISSING_INPUT, `node is tombstoned: ${id}`);
  }
  return node;
}

// Certificate for a node: a hash-chain segment linking the sorted
// certificate hashes of its dependencies (GENESIS for roots) to the
// node's own identity, input hash and code version.
export function computeCert(store, spec) {
  const deps = spec.deps ?? [];
  const prev = deps.length
    ? sha256(deps.slice().sort().map((d) => rawNode(store, d).cert.hash).join('|'))
    : GENESIS;
  const hash = sha256([prev, spec.id, spec.inputHash, spec.codeVersion].join('|'));
  return { prev, hash };
}

function rawKey(node) {
  return sha256(['raw', node.id, node.inputHash, node.codeVersion].join('|'));
}

// Ancestor vector: topo-sorted list of {id, key} for every transitive
// dependency. A cache key matches only if the entire causal past matches.
export function ancestorVector(store, id) {
  const seen = new Set();
  const order = [];
  const visit = (nid) => {
    if (seen.has(nid)) return;
    seen.add(nid);
    for (const dep of rawNode(store, nid).deps) visit(dep);
    order.push(nid);
  };
  for (const dep of rawNode(store, id).deps) visit(dep);
  return order.map((nid) => ({ id: nid, key: rawKey(store.nodes[nid]) }));
}

export function cacheKey(store, id) {
  const node = rawNode(store, id);
  return sha256(
    JSON.stringify({
      id: node.id,
      codeVersion: node.codeVersion,
      inputHash: node.inputHash,
      ancestors: ancestorVector(store, id),
    }),
  );
}

function ancestorsOf(store, id) {
  const out = new Set();
  const stack = [...rawNode(store, id).deps];
  while (stack.length) {
    const cur = stack.pop();
    if (out.has(cur)) continue;
    out.add(cur);
    for (const dep of rawNode(store, cur).deps) stack.push(dep);
  }
  return out;
}

function descendantsOf(store, id) {
  const out = new Set();
  for (const node of liveNodes(store)) {
    if (node.id !== id && ancestorsOf(store, node.id).has(id)) out.add(node.id);
  }
  return out;
}

function assertAcyclic(store, id, deps) {
  // Adding id <- deps closes a cycle iff id is reachable from any new dep.
  if (deps.includes(id)) {
    throw new DagError(ERR.CYCLE, `self dependency on ${id}`);
  }
  for (const dep of deps) {
    if (ancestorsOf(store, dep).has(id)) {
      throw new DagError(ERR.CYCLE, `adding ${id} <- ${dep} closes a cycle`);
    }
  }
}

// Recompute certificates for a changed node and its descendants, in
// topological order, so the chain from roots to leaves stays verifiable.
function rechain(store, changedId) {
  const affected = new Set([changedId, ...descendantsOf(store, changedId)]);
  for (const id of topoOrder(store)) {
    if (!affected.has(id)) continue;
    const node = store.nodes[id];
    node.cert = computeCert(store, node);
  }
}

export function add(store, spec) {
  const { id } = spec;
  if (!id || typeof id !== 'string') {
    throw new DagError(ERR.MISSING_INPUT, 'node spec requires a string id');
  }
  const deps = spec.deps ?? [];
  if (deps.includes(id)) {
    throw new DagError(ERR.CYCLE, `self dependency on ${id}`);
  }
  for (const dep of deps) liveNode(store, dep); // throws MISSING_INPUT
  const existing = store.nodes[id];
  if (existing && existing.tombstone) {
    throw new DagError(ERR.MISSING_INPUT, `node ${id} is tombstoned`);
  }
  if (existing) assertAcyclic(store, id, deps);
  const node = {
    id,
    deps: deps.slice(),
    inputHash: spec.inputHash,
    codeVersion: spec.codeVersion,
    tombstone: false,
    cert: null,
  };
  store.nodes[id] = node;
  const expected = computeCert(store, node);
  if (spec.cert && (spec.cert.prev !== expected.prev || spec.cert.hash !== expected.hash)) {
    delete store.nodes[id];
    if (existing) store.nodes[id] = existing;
    throw new DagError(ERR.BAD_CERT, `certificate mismatch for node ${id}`);
  }
  node.cert = expected;
  if (existing) {
    // Updating a step rewrites the causal past of its descendants: drop
    // exactly their cache entries and re-chain their certificates.
    rechain(store, id);
    for (const victim of [id, ...descendantsOf(store, id)]) {
      delete store.cache[victim];
    }
  }
  return { id, cert: node.cert };
}

// Depth-first topological order (dependencies first) over every node
// reachable from live nodes, including retained tombstones in live chains.
export function topoOrder(store) {
  const seen = new Set();
  const order = [];
  const visit = (nid) => {
    if (seen.has(nid)) return;
    seen.add(nid);
    for (const dep of rawNode(store, nid).deps) visit(dep);
    order.push(nid);
  };
  for (const node of liveNodes(store)) visit(node.id);
  return order;
}

export function run(store, targets) {
  const wanted =
    targets && targets.length
      ? targets.map((t) => liveNode(store, t).id)
      : liveNodes(store).map((n) => n.id);
  const needed = new Set(wanted);
  for (const t of wanted) for (const a of ancestorsOf(store, t)) needed.add(a);
  const order = topoOrder(store).filter(
    (id) => needed.has(id) && !store.nodes[id].tombstone,
  );
  const computed = [];
  const cached = [];
  const results = {};
  for (const id of order) {
    const key = cacheKey(store, id);
    const hit = store.cache[id];
    if (hit && hit.key === key) {
      cached.push(id);
      results[id] = hit.result;
      continue;
    }
    const result = sha256(`result|${key}`);
    store.cache[id] = { key, result, at: new Date().toISOString() };
    computed.push(id);
    results[id] = result;
  }
  return { computed, cached, results };
}

// Correct a step (new input hash and/or code version) and invalidate exactly
// the node plus its transitive descendants. Returns the invalidated set.
export function invalidate(store, spec) {
  const node = liveNode(store, spec.id);
  if (spec.inputHash !== undefined) node.inputHash = spec.inputHash;
  if (spec.codeVersion !== undefined) node.codeVersion = spec.codeVersion;
  rechain(store, node.id);
  const affected = [node.id, ...descendantsOf(store, node.id)];
  for (const victim of affected) delete store.cache[victim];
  return { invalidated: affected.sort() };
}

// Verify every certificate chain segment from roots to leaves.
export function audit(store) {
  const errors = [];
  const order = topoOrder(store);
  for (const id of order) {
    const node = store.nodes[id];
    const expected = computeCert(store, node);
    if (!node.cert || node.cert.prev !== expected.prev || node.cert.hash !== expected.hash) {
      errors.push({ id, code: ERR.BAD_CERT, expected, found: node.cert });
    }
  }
  return { ok: errors.length === 0, nodes: order.length, errors };
}

export function registerRunner(store, runnerId) {
  if (!store.runners.includes(runnerId)) store.runners.push(runnerId);
  return { runners: store.runners.slice() };
}

// Mark a node deleted. The record stays (tombstone) so surviving certificate
// chains and cache keys keep resolving until gc collects it.
export function tombstone(store, id) {
  const node = liveNode(store, id);
  node.tombstone = true;
  delete store.cache[id];
  return { tombstoned: id };
}

// Collect tombstoned nodes only when every registered runner confirms them
// unreachable and no live node still depends on them.
export function gc(store, confirmations = {}) {
  const collected = [];
  const retained = [];
  for (const node of Object.values(store.nodes)) {
    if (!node.tombstone) continue;
    const allConfirm =
      store.runners.length > 0 &&
      store.runners.every((r) => (confirmations[r] ?? []).includes(node.id));
    const stillReferenced = liveNodes(store).some((n) => n.deps.includes(node.id));
    if (allConfirm && !stillReferenced) {
      delete store.nodes[node.id];
      delete store.cache[node.id];
      collected.push(node.id);
    } else {
      retained.push(node.id);
    }
  }
  return { collected: collected.sort(), retained: retained.sort() };
}
