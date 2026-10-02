import { sha256, canonical } from './hash.js';
import { BUILDERS, computeArtifactHash } from './builders.js';

export class BuildError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'BuildError';
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, extra = {}) => ({ ok: false, error: { code, message, ...extra } });

const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function sortedEdgeEntries(node) {
  return Object.entries(node.edges ?? {}).sort(([a], [b]) => byId(a, b));
}

// Kahn topological sort with id-ascending ready set. Same-layer nodes are
// emitted in ascending id order. Nodes left over form dependency cycles.
export function topoOrder(nodes) {
  const ids = [...nodes.keys()].sort(byId);
  const indegree = new Map();
  const dependents = new Map(ids.map((id) => [id, []]));
  for (const id of ids) {
    const node = nodes.get(id);
    let degree = 0;
    if (node.type !== 'file') {
      for (const [, target] of sortedEdgeEntries(node)) {
        if (nodes.has(target)) {
          degree += 1;
          dependents.get(target).push(id);
        }
      }
    }
    indegree.set(id, degree);
  }
  const ready = ids.filter((id) => indegree.get(id) === 0);
  const order = [];
  const layer = new Map();
  while (ready.length > 0) {
    ready.sort(byId);
    const id = ready.shift();
    let depth = 0;
    const node = nodes.get(id);
    if (node.type !== 'file') {
      for (const [, target] of sortedEdgeEntries(node)) {
        if (nodes.has(target)) depth = Math.max(depth, (layer.get(target) ?? 0) + 1);
      }
    }
    layer.set(id, depth);
    order.push({ id, layer: depth });
    for (const dependent of dependents.get(id)) {
      indegree.set(dependent, indegree.get(dependent) - 1);
      if (indegree.get(dependent) === 0) ready.push(dependent);
    }
  }
  const cyclic = ids.filter((id) => !layer.has(id));
  return { order, cyclic, dependents };
}

// Pure per-node status computation. getStatus(target) must return the
// already-computed status of an input node.
export function computeNode(id, nodes, getStatus) {
  const node = nodes.get(id);
  if (node.type === 'file') {
    return { state: 'ok', hash: sha256(`file\0${node.content}`) };
  }
  if (node.type === 'artifact' && !BUILDERS[node.builder]) {
    return { state: 'invalid', code: 'E_BUILDER', message: `unknown builder: ${node.builder}` };
  }
  const inputs = [];
  for (const [edge, target] of sortedEdgeEntries(node)) {
    if (!nodes.has(target)) {
      return { state: 'invalid', code: 'E_INPUT', message: `edge '${edge}' targets missing node '${target}'` };
    }
    const status = getStatus(target);
    if (!status || status.state !== 'ok') {
      return { state: 'blocked', reason: `input '${target}' is unavailable` };
    }
    inputs.push({ edge, target, hash: status.hash });
  }
  if (node.type === 'artifact') {
    return { state: 'ok', hash: computeArtifactHash(node.builder, inputs) };
  }
  return { state: 'ok', hash: sha256(`release\0${canonical(inputs.map((i) => [i.edge, i.target, i.hash]))}`) };
}

export function projectionOf(status) {
  const hashes = {};
  const blocked = [];
  for (const [id, st] of [...status.entries()].sort(([a], [b]) => byId(a, b))) {
    hashes[id] = st.state === 'ok' ? st.hash : null;
    if (st.state === 'blocked') blocked.push(id);
  }
  return { hashes, blocked };
}

export function diffProjection(prev, next) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const id of Object.keys(next.hashes)) {
    if (!(id in prev.hashes)) added.push(id);
  }
  for (const id of Object.keys(prev.hashes)) {
    if (!(id in next.hashes)) removed.push(id);
  }
  for (const id of Object.keys(next.hashes)) {
    if (id in prev.hashes && prev.hashes[id] !== next.hashes[id]) {
      changed.push({ id, from: prev.hashes[id], to: next.hashes[id] });
    }
  }
  return { added, removed, changed, blocked: next.blocked };
}

export function errorsOf(status) {
  const errors = [];
  for (const [id, st] of [...status.entries()].sort(([a], [b]) => byId(a, b))) {
    if (st.state === 'invalid') errors.push({ node: id, code: st.code, message: st.message });
  }
  return errors;
}

export function certificatesFor(nodes, status, txId) {
  const certificates = [];
  for (const [id, node] of [...nodes.entries()].sort(([a], [b]) => byId(a, b))) {
    if (node.type !== 'release') continue;
    const st = status.get(id);
    const inputs = sortedEdgeEntries(node).map(([edge, target]) => {
      const targetStatus = status.get(target);
      return { edge, target, hash: targetStatus && targetStatus.state === 'ok' ? targetStatus.hash : null };
    });
    const blocked = !st || st.state !== 'ok';
    const certificate = { release: id, txId, hash: st && st.state === 'ok' ? st.hash : null, blocked, inputs };
    certificate.digest = sha256(canonical(certificate));
    certificates.push(certificate);
  }
  return certificates;
}

function statusEqual(a, b) {
  if (!a || !b) return a === b;
  return a.state === b.state && a.hash === b.hash && a.code === b.code;
}

function need(condition, code, message) {
  if (!condition) throw new BuildError(code, message);
}

function edgesToObject(edges) {
  need(Array.isArray(edges), 'E_OP', 'edges must be an array of {id, target}');
  const object = {};
  for (const edge of edges) {
    need(edge && typeof edge.id === 'string' && typeof edge.target === 'string', 'E_OP', 'edge requires string id and target');
    need(!(edge.id in object), 'E_OP', `duplicate edge id: ${edge.id}`);
    object[edge.id] = edge.target;
  }
  return object;
}

function applyOp(nodes, op) {
  need(op && typeof op === 'object' && typeof op.op === 'string', 'E_OP', 'operation requires an "op" field');
  switch (op.op) {
    case 'upsert_file': {
      need(typeof op.id === 'string' && typeof op.content === 'string', 'E_OP', 'upsert_file requires string id and content');
      nodes.set(op.id, { type: 'file', content: op.content });
      return;
    }
    case 'add_artifact': {
      need(typeof op.id === 'string' && typeof op.builder === 'string', 'E_OP', 'add_artifact requires string id and builder');
      nodes.set(op.id, { type: 'artifact', builder: op.builder, edges: edgesToObject(op.edges) });
      return;
    }
    case 'add_release': {
      need(typeof op.id === 'string', 'E_OP', 'add_release requires string id');
      nodes.set(op.id, { type: 'release', edges: edgesToObject(op.edges) });
      return;
    }
    case 'remove_node': {
      need(typeof op.id === 'string', 'E_OP', 'remove_node requires string id');
      nodes.delete(op.id);
      return;
    }
    case 'add_edge': {
      const node = nodes.get(op.node);
      need(node && node.type !== 'file', 'E_NODE', `add_edge target is not an artifact/release: ${op.node}`);
      need(op.edge && typeof op.edge.id === 'string' && typeof op.edge.target === 'string', 'E_OP', 'add_edge requires edge {id, target}');
      node.edges[op.edge.id] = op.edge.target;
      return;
    }
    case 'remove_edge': {
      const node = nodes.get(op.node);
      need(node && node.type !== 'file', 'E_NODE', `remove_edge target is not an artifact/release: ${op.node}`);
      need(typeof op.edgeId === 'string', 'E_OP', 'remove_edge requires edgeId');
      delete node.edges[op.edgeId];
      return;
    }
    default:
      throw new BuildError('E_OP', `unknown operation: ${op.op}`);
  }
}

export function applyOps(nodes, ops) {
  const next = structuredClone(nodes);
  for (const op of ops) applyOp(next, op);
  return next;
}

function changeReason(prev, next) {
  if (prev.type !== next.type) return `node-type-changed:${prev.type}->${next.type}`;
  if (next.type === 'file') return 'file-content-changed';
  const reasons = [];
  if (next.type === 'artifact' && prev.builder !== next.builder) reasons.push('builder-changed');
  const prevEdges = prev.edges ?? {};
  const nextEdges = next.edges ?? {};
  for (const edgeId of Object.keys(nextEdges)) {
    if (!(edgeId in prevEdges)) reasons.push(`edge-added:${edgeId}`);
  }
  for (const edgeId of Object.keys(prevEdges)) {
    if (!(edgeId in nextEdges)) reasons.push(`edge-removed:${edgeId}`);
  }
  for (const edgeId of Object.keys(nextEdges)) {
    if (edgeId in prevEdges && prevEdges[edgeId] !== nextEdges[edgeId]) reasons.push(`edge-retargeted:${edgeId}`);
  }
  return reasons.length > 0 ? reasons.join(';') : 'node-definition-changed';
}

function seedChanges(oldNodes, newNodes) {
  const seeds = new Map();
  const removed = [];
  for (const [id, node] of newNodes) {
    if (!oldNodes.has(id)) {
      seeds.set(id, 'node-added');
    } else {
      const prev = oldNodes.get(id);
      if (canonical(prev) !== canonical(node)) seeds.set(id, changeReason(prev, node));
    }
  }
  for (const id of oldNodes.keys()) {
    if (!newNodes.has(id)) removed.push(id);
  }
  for (const removedId of removed) {
    for (const [id, node] of newNodes) {
      if (node.type === 'file') continue;
      if (Object.values(node.edges ?? {}).includes(removedId) && !seeds.has(id)) {
        seeds.set(id, `input-removed:${removedId}`);
      }
    }
  }
  return { seeds, removed };
}

export class Engine {
  constructor() {
    this.nodes = new Map();
    this.status = new Map();
    this.history = [];
    this.txSeq = 0;
    this.lastTxId = null;
  }

  transact({ id, ops } = {}) {
    if (!Array.isArray(ops) || ops.length === 0) {
      return fail('E_TX_OPS', 'transaction requires a non-empty ops array');
    }
    const txId = id ?? `tx-${this.txSeq + 1}`;
    if (this.history.some((entry) => entry.txId === txId)) {
      return fail('E_TX_ID', `duplicate transaction id: ${txId}`);
    }
    let nextNodes;
    try {
      nextNodes = applyOps(this.nodes, ops);
    } catch (error) {
      if (error instanceof BuildError) return fail(error.code, error.message, error.details ?? {});
      throw error;
    }
    const { cyclic } = topoOrder(nextNodes);
    if (cyclic.length > 0) {
      return fail('E_CYCLE', `dependency cycle detected involving: ${cyclic.join(', ')}`, { nodes: cyclic });
    }
    const { seeds, removed } = seedChanges(this.nodes, nextNodes);
    this.history.push({ txId, nodes: structuredClone(this.nodes), status: structuredClone(this.status) });
    this.txSeq += 1;
    this.nodes = nextNodes;
    this.lastTxId = txId;
    return this.#build(seeds, removed, txId);
  }

  #build(seeds, removedIds, txId) {
    if (this.nodes.size === 0) {
      this.status = new Map();
      return fail('E_EMPTY', 'nothing to build: the graph has no nodes');
    }
    const { order, dependents } = topoOrder(this.nodes);
    const prevProjection = projectionOf(this.status);
    const prevStatus = this.status;
    const next = new Map(prevStatus);
    for (const removedId of removedIds) next.delete(removedId);
    const dirty = new Map(seeds);
    const invalidations = [];
    const layers = new Map(order.map((entry) => [entry.id, entry.layer]));
    for (const { id } of order) {
      if (!dirty.has(id)) continue;
      const before = prevStatus.get(id);
      const after = computeNode(id, this.nodes, (target) => next.get(target));
      next.set(id, after);
      invalidations.push({ id, reason: dirty.get(id) });
      if (!statusEqual(before, after)) {
        for (const dependent of dependents.get(id) ?? []) {
          if (!dirty.has(dependent)) dirty.set(dependent, `input-changed:${id}`);
        }
      }
    }
    invalidations.sort((a, b) => (layers.get(a.id) - layers.get(b.id)) || byId(a.id, b.id));
    this.status = next;
    const projection = projectionOf(next);
    return {
      ok: true,
      txId,
      diff: diffProjection(prevProjection, projection),
      invalidations,
      errors: errorsOf(next),
      blocked: projection.blocked,
      hashes: projection.hashes,
      certificates: certificatesFor(this.nodes, next, txId),
    };
  }

  buildAll() {
    const seeds = new Map([...this.nodes.keys()].map((id) => [id, 'full-build']));
    return this.#build(seeds, [], this.lastTxId);
  }

  rollback(txId) {
    if (typeof txId !== 'string') return fail('E_TX_NOT_FOUND', 'rollback requires a transaction id string');
    const index = this.history.findIndex((entry) => entry.txId === txId);
    if (index === -1) return fail('E_TX_NOT_FOUND', `unknown transaction id: ${txId}`);
    const discarded = this.history.slice(index).map((entry) => entry.txId);
    const snapshot = this.history[index];
    const prevProjection = projectionOf(this.status);
    this.nodes = structuredClone(snapshot.nodes);
    this.status = structuredClone(snapshot.status);
    this.history.length = index;
    this.lastTxId = index > 0 ? this.history[index - 1].txId : null;
    const projection = projectionOf(this.status);
    return {
      ok: true,
      rolledBack: txId,
      discarded,
      diff: diffProjection(prevProjection, projection),
      hashes: projection.hashes,
      blocked: projection.blocked,
    };
  }

  state() {
    const projection = projectionOf(this.status);
    return {
      ok: true,
      hashes: projection.hashes,
      blocked: projection.blocked,
      errors: errorsOf(this.status),
      certificates: certificatesFor(this.nodes, this.status, this.lastTxId),
    };
  }
}
