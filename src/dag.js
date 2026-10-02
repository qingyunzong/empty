'use strict';
// Reproducibility DAG core library.
// Nodes form a causal DAG; run cache keys bind code version, input hash and
// the ancestor vector; evidence certificates are segments of a hash chain;
// deletion is tombstone-based and gc only reclaims entries that every
// runner (any node holding a valid cache entry) confirms unreachable.

const crypto = require('node:crypto');

class DagError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DagError';
    this.code = code; // CYCLE | MISSING_INPUT | BAD_CERT
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Deterministic stringify so hashes are stable across key insertion order.
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

const GENESIS = 'GENESIS';

function createState() {
  return {
    nodes: {},   // id -> { id, codeVersion, inputs: [id], params, inputHash }
    cache: {},   // id -> { key, outputHash, certHash, valid, tombstone }
    chain: [],   // hash chain of run events: { seq, prev, nodeId, key, outputHash, hash }
    runners: {}, // name -> [rootIds] heads pinned at run time
  };
}

function inputHashOf(inputs, params) {
  return sha256(stable({ inputs: [...inputs].sort(), params }));
}

function getNode(state, id) {
  const node = state.nodes[id];
  if (!node) throw new DagError('MISSING_INPUT', `unknown node: ${id}`);
  return node;
}

// Transitive ancestors of id (excluding id), as a Set.
function ancestors(state, id) {
  const seen = new Set();
  const stack = [...getNode(state, id).inputs];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    const node = state.nodes[cur];
    if (node) stack.push(...node.inputs);
  }
  return seen;
}

// Transitive descendants of id (excluding id), as a Set.
function descendants(state, id) {
  const children = new Map();
  for (const node of Object.values(state.nodes)) {
    for (const input of node.inputs) {
      if (!children.has(input)) children.set(input, []);
      children.get(input).push(node.id);
    }
  }
  const seen = new Set();
  const stack = [...(children.get(id) || [])];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(children.get(cur) || []));
  }
  return seen;
}

function assertAcyclic(state, id, inputs) {
  if (inputs.includes(id)) {
    throw new DagError('CYCLE', `self dependency on ${id}`);
  }
  // Edge id -> input closes a cycle iff id is already an ancestor of input.
  for (const input of inputs) {
    if (ancestors(state, input).has(id)) {
      throw new DagError('CYCLE', `adding ${id} <- ${input} closes a cycle`);
    }
  }
}

// Register a step. Re-adding an existing id is a *correction*: the node is
// updated and exactly its descendant cone (itself included) is invalidated.
function addNode(state, { id, codeVersion = '0', inputs = [], params = {} }) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new DagError('MISSING_INPUT', 'node id must be a non-empty string');
  }
  for (const input of inputs) {
    if (!state.nodes[input]) {
      throw new DagError('MISSING_INPUT', `node ${id} depends on missing input ${input}`);
    }
  }
  assertAcyclic(state, id, inputs);
  const correcting = Boolean(state.nodes[id]);
  state.nodes[id] = { id, codeVersion, inputs: [...inputs], params, inputHash: inputHashOf(inputs, params) };
  if (correcting) return { id, corrected: true, invalidated: invalidate(state, id) };
  return { id, corrected: false, invalidated: [] };
}

// Cache key binds code version, input hash and the sorted ancestor vector
// (cache keys of every transitive ancestor).
function cacheKeyOf(state, id) {
  const node = getNode(state, id);
  const vector = [...ancestors(state, id)]
    .map((a) => {
      const entry = state.cache[a];
      if (!entry || !entry.valid) {
        throw new DagError('MISSING_INPUT', `ancestor ${a} of ${id} has no valid run`);
      }
      return entry.key;
    })
    .sort();
  return sha256(stable({ codeVersion: node.codeVersion, inputHash: node.inputHash, ancestorVector: vector }));
}

function topoOrder(state, ids) {
  const wanted = new Set(ids);
  const done = new Set();
  const order = [];
  const visit = (nid) => {
    if (done.has(nid) || !wanted.has(nid)) return;
    for (const input of state.nodes[nid].inputs) visit(input);
    done.add(nid);
    order.push(nid);
  };
  for (const nid of ids) visit(nid);
  return order;
}

function appendChain(state, nodeId, key, outputHash) {
  const prev = state.chain.length ? state.chain[state.chain.length - 1].hash : GENESIS;
  const seq = state.chain.length;
  const hash = sha256(stable({ seq, prev, nodeId, key, outputHash }));
  const link = { seq, prev, nodeId, key, outputHash, hash };
  state.chain.push(link);
  return link;
}

// Run one node, recursively (re)running any invalid ancestors first.
function runNode(state, id, runner = 'default') {
  getNode(state, id);
  const cone = [id, ...ancestors(state, id)];
  const results = [];
  for (const nid of topoOrder(state, cone)) {
    const entry = state.cache[nid];
    if (entry && entry.valid) continue;
    const key = cacheKeyOf(state, nid);
    const outputHash = sha256('output:' + key);
    const link = appendChain(state, nid, key, outputHash);
    state.cache[nid] = { key, outputHash, certHash: link.hash, valid: true, tombstone: false };
    results.push({ id: nid, key, cert: link.hash });
  }
  if (!state.runners[runner]) state.runners[runner] = [];
  if (!state.runners[runner].includes(id)) state.runners[runner].push(id);
  return results;
}

// Run every node that lacks a valid cache entry, in topological order.
function runAll(state, runner = 'default') {
  const results = [];
  for (const nid of topoOrder(state, Object.keys(state.nodes))) {
    results.push(...runNode(state, nid, runner));
  }
  return results;
}

// Invalidate exactly id and its transitive descendants. Entries are
// tombstoned, not deleted, so audit can still trace history until gc.
function invalidate(state, id) {
  getNode(state, id);
  const set = [id, ...descendants(state, id)];
  for (const nid of set) {
    const entry = state.cache[nid];
    if (entry && entry.valid) {
      entry.valid = false;
      entry.tombstone = true;
    }
  }
  return set.slice().sort();
}

// Verify the evidence chain and every live certificate, from roots to
// leaves: each valid entry's key is recomputed from the current graph and
// its certificate must appear in an intact hash chain.
function audit(state) {
  // 1. Hash chain integrity.
  let prev = GENESIS;
  for (const link of state.chain) {
    const expect = sha256(stable({ seq: link.seq, prev, nodeId: link.nodeId, key: link.key, outputHash: link.outputHash }));
    if (link.prev !== prev || link.hash !== expect) {
      throw new DagError('BAD_CERT', `chain link ${link.seq} for node ${link.nodeId} fails verification`);
    }
    prev = link.hash;
  }
  const chainHashes = new Set(state.chain.map((l) => l.hash));
  // 2. Every valid cache entry: cert present in chain, key reproducible.
  const leaves = [];
  const childCount = new Map();
  for (const node of Object.values(state.nodes)) {
    for (const input of node.inputs) childCount.set(input, (childCount.get(input) || 0) + 1);
  }
  let checked = 0;
  for (const nid of topoOrder(state, Object.keys(state.nodes))) {
    const entry = state.cache[nid];
    if (!entry || !entry.valid) continue;
    if (!chainHashes.has(entry.certHash)) {
      throw new DagError('BAD_CERT', `node ${nid} certificate not found in chain`);
    }
    const expectKey = cacheKeyOf(state, nid);
    if (entry.key !== expectKey) {
      throw new DagError('BAD_CERT', `node ${nid} cache key does not match its certificate`);
    }
    checked += 1;
    if (!childCount.get(nid)) leaves.push(nid);
  }
  return { ok: true, checked, leaves: leaves.sort(), chainLength: state.chain.length };
}

// Garbage-collect tombstoned entries that no runner can reach. A node is
// reachable iff it is an ancestor-or-self of some runner-pinned head whose
// cache entry is still valid. Only tombstones failing every runner's
// reachability check are physically removed.
function gc(state) {
  const reachable = new Set();
  for (const roots of Object.values(state.runners)) {
    for (const root of roots) {
      if (!state.nodes[root]) continue;
      const entry = state.cache[root];
      if (!entry || !entry.valid) continue;
      reachable.add(root);
      for (const a of ancestors(state, root)) reachable.add(a);
    }
  }
  const removed = [];
  for (const [nid, entry] of Object.entries(state.cache)) {
    if (entry.tombstone && !entry.valid && !reachable.has(nid)) {
      delete state.cache[nid];
      removed.push(nid);
    }
  }
  // Drop runner pins that no longer resolve to a node.
  for (const [name, roots] of Object.entries(state.runners)) {
    state.runners[name] = roots.filter((r) => state.nodes[r]);
  }
  return { removed: removed.sort(), reachable: [...reachable].sort() };
}

module.exports = {
  DagError,
  createState,
  addNode,
  runNode,
  runAll,
  invalidate,
  audit,
  gc,
  ancestors,
  descendants,
  cacheKeyOf,
  stable,
  sha256,
};
