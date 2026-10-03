import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

export const ACTIVE = 'active';
export const ROLLED_BACK = 'rolled-back';

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function loadState(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  return normalizeState(JSON.parse(raw));
}

// Validates the raw JSON document and builds an indexed in-memory tree.
// A node: { id, parent, cost, status, hash }. Derived: children, depth, path.
export function normalizeState(data) {
  if (data === null || typeof data !== 'object' || !Array.isArray(data.nodes)) {
    throw new Error('invalid state: expected an object with a "nodes" array');
  }
  const nodes = new Map();
  const order = [];
  for (const raw of data.nodes) {
    if (!raw || typeof raw.id !== 'string' || raw.id.length === 0) {
      throw new Error('invalid state: every node needs a non-empty string id');
    }
    if (nodes.has(raw.id)) throw new Error(`invalid state: duplicate node id "${raw.id}"`);
    if (raw.parent !== null && typeof raw.parent !== 'string') {
      throw new Error(`invalid state: node "${raw.id}" parent must be a string or null`);
    }
    if (typeof raw.cost !== 'number' || !Number.isFinite(raw.cost) || raw.cost < 0) {
      throw new Error(`invalid state: node "${raw.id}" cost must be a non-negative finite number`);
    }
    if (raw.status !== ACTIVE && raw.status !== ROLLED_BACK) {
      throw new Error(`invalid state: node "${raw.id}" status must be "${ACTIVE}" or "${ROLLED_BACK}"`);
    }
    const hash = typeof raw.hash === 'string' && raw.hash.length > 0 ? raw.hash : sha256(`gen:${raw.id}`);
    nodes.set(raw.id, {
      id: raw.id,
      parent: raw.parent ?? null,
      cost: raw.cost,
      status: raw.status,
      hash,
      children: [],
      depth: 0,
      path: '',
    });
    order.push(raw.id);
  }

  let root = null;
  for (const node of nodes.values()) {
    if (node.parent === null) {
      if (root !== null) throw new Error('invalid state: exactly one root (parent: null) is required');
      root = node.id;
    } else {
      const parent = nodes.get(node.parent);
      if (!parent) throw new Error(`invalid state: node "${node.id}" has unknown parent "${node.parent}"`);
      parent.children.push(node.id);
    }
  }
  if (root === null) throw new Error('invalid state: exactly one root (parent: null) is required');

  const visited = new Set();
  const stack = [[root, 0, `/${root}`]];
  while (stack.length > 0) {
    const [id, depth, path] = stack.pop();
    if (visited.has(id)) throw new Error(`invalid state: cycle detected at node "${id}"`);
    visited.add(id);
    const node = nodes.get(id);
    node.depth = depth;
    node.path = path;
    for (const child of node.children) stack.push([child, depth + 1, `${path}/${child}`]);
  }
  if (visited.size !== nodes.size) {
    throw new Error('invalid state: every node must descend from the single root (cycle or detached nodes found)');
  }
  return { nodes, root, order };
}

export function serializeState(state) {
  const nodes = state.order.map((id) => {
    const n = state.nodes.get(id);
    return { id: n.id, parent: n.parent, cost: n.cost, status: n.status, hash: n.hash };
  });
  return JSON.stringify({ nodes }, null, 2) + '\n';
}

// Atomic write: temp file + rename, so a crash never leaves a half-written state.
export function saveState(filePath, state) {
  const tmp = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmp, serializeState(state));
  renameSync(tmp, filePath);
}

export function descendantsOf(state, id) {
  const out = [];
  const stack = [...state.nodes.get(id).children];
  while (stack.length > 0) {
    const cur = stack.pop();
    out.push(cur);
    stack.push(...state.nodes.get(cur).children);
  }
  return out;
}

export function ancestorsOf(state, id) {
  const out = [];
  let cur = state.nodes.get(id).parent;
  while (cur !== null) {
    out.push(cur);
    cur = state.nodes.get(cur).parent;
  }
  return out;
}

// Rollback closure: every selected node plus all of its descendants.
// A Set is used so shared nodes (reachable from several selected nodes) count once.
export function closureOf(state, ids) {
  const set = new Set();
  const stack = [...ids];
  while (stack.length > 0) {
    const id = stack.pop();
    if (set.has(id)) continue;
    set.add(id);
    stack.push(...state.nodes.get(id).children);
  }
  return set;
}

// Deterministic digest of the whole state, used for certificate before/after hashes.
export function canonicalDigest(state) {
  const nodes = [...state.nodes.values()]
    .map((n) => ({ id: n.id, parent: n.parent, cost: n.cost, status: n.status, hash: n.hash }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sha256(JSON.stringify({ nodes }));
}
