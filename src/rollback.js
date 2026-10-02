'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const STATUS_ACTIVE = 'active';
const STATUS_ROLLED_BACK = 'rolled_back';
const STATUSES = new Set([STATUS_ACTIVE, STATUS_ROLLED_BACK]);

class StateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StateError';
  }
}

// Deterministic post-rollback version hash for a node.
function computeNewHash(id, oldHash) {
  return crypto.createHash('sha256').update(`rollback:${id}:${oldHash}`).digest('hex');
}

function isNode(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Validates structural and status invariants of an activity tree:
//  - root exists and every node is reachable from it (DAG, no cycles);
//  - each node has a non-empty path, non-negative integer cost, valid status and hash;
//  - children references exist;
//  - ancestor/descendant status constraint: a rolled-back node may not have
//    active descendants (rolled-back status is descendant-closed).
function validateState(state) {
  if (!isNode(state)) throw new StateError('state must be an object');
  if (!isNode(state.nodes)) throw new StateError('state.nodes must be an object keyed by node id');
  if (typeof state.root !== 'string' || !Object.hasOwn(state.nodes, state.root)) {
    throw new StateError('state.root must reference an existing node');
  }

  for (const [id, node] of Object.entries(state.nodes)) {
    if (!isNode(node)) throw new StateError(`node ${id} must be an object`);
    if (typeof node.path !== 'string' || node.path.length === 0) {
      throw new StateError(`node ${id} must have a non-empty path`);
    }
    if (!Array.isArray(node.children) || node.children.some((c) => typeof c !== 'string')) {
      throw new StateError(`node ${id} children must be an array of node ids`);
    }
    for (const child of node.children) {
      if (!Object.hasOwn(state.nodes, child)) {
        throw new StateError(`node ${id} references unknown child ${child}`);
      }
    }
    if (!Number.isInteger(node.cost) || node.cost < 0) {
      throw new StateError(`node ${id} cost must be a non-negative integer`);
    }
    if (!STATUSES.has(node.status)) {
      throw new StateError(`node ${id} has invalid status ${JSON.stringify(node.status)}`);
    }
    if (typeof node.hash !== 'string' || node.hash.length === 0) {
      throw new StateError(`node ${id} must have a non-empty hash`);
    }
  }

  const color = new Map(); // 1 = visiting, 2 = done
  const visit = (id) => {
    const mark = color.get(id) || 0;
    if (mark === 1) throw new StateError(`cycle detected at node ${id}`);
    if (mark === 2) return;
    color.set(id, 1);
    for (const child of state.nodes[id].children) visit(child);
    color.set(id, 2);
  };
  visit(state.root);
  for (const id of Object.keys(state.nodes)) {
    if (!color.has(id)) throw new StateError(`node ${id} is not reachable from root`);
  }

  for (const [id, node] of Object.entries(state.nodes)) {
    if (node.status !== STATUS_ROLLED_BACK) continue;
    for (const child of node.children) {
      if (state.nodes[child].status !== STATUS_ROLLED_BACK) {
        throw new StateError(
          `node ${id} is rolled back but its descendant ${child} is active`,
        );
      }
    }
  }
}

function loadState(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new StateError(`cannot read state file ${file}: ${err.message}`);
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch (err) {
    throw new StateError(`cannot parse state file ${file}: ${err.message}`);
  }
  validateState(state);
  return state;
}

function saveState(file, state) {
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

function activeChildren(state, id) {
  return state.nodes[id].children.filter(
    (child) => state.nodes[child].status === STATUS_ACTIVE,
  );
}

// Lexicographic concatenation of the nodes' paths (paths sorted first).
function concatOf(state, ids) {
  return ids.map((id) => state.nodes[id].path).sort().join('');
}

function byPath(state, a, b) {
  const pa = state.nodes[a].path;
  const pb = state.nodes[b].path;
  if (pa < pb) return -1;
  if (pa > pb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// Minimum-cost way to roll back `id`, as a billed (selected) node set.
// A node is rolled back when it is billed directly (its rollback cascades over
// its whole active subtree) or when every active child of it is rolled back.
// Already rolled-back nodes are never billed again. Shared nodes (multiple
// parents) are billed at most once. Ties on cost are broken by the
// lexicographically smallest concatenation of sorted node paths.
function solveCover(state, id, memo) {
  const node = state.nodes[id];
  if (node.status === STATUS_ROLLED_BACK) {
    return { cost: 0, nodes: [], concat: '' };
  }
  if (memo.has(id)) return memo.get(id);

  let best = { cost: node.cost, nodes: [id], concat: node.path };

  const children = activeChildren(state, id);
  if (children.length > 0) {
    const merged = new Set();
    for (const child of children) {
      for (const billed of solveCover(state, child, memo).nodes) merged.add(billed);
    }
    const nodes = [...merged];
    const candidate = {
      cost: nodes.reduce((sum, nid) => sum + state.nodes[nid].cost, 0),
      nodes,
      concat: concatOf(state, nodes),
    };
    if (
      candidate.cost < best.cost ||
      (candidate.cost === best.cost && candidate.concat < best.concat)
    ) {
      best = candidate;
    }
  }

  memo.set(id, best);
  return best;
}

// Computes which nodes physically transition to rolled-back, in execution
// order (active descendants always roll back before their ancestors; shared
// nodes appear once). A node transitions when it is inside the cascade of a
// billed node, or when all of its active children transition.
function computeCoverage(state, targetId, billed) {
  const cascade = new Set();
  const markCascade = (id) => {
    const node = state.nodes[id];
    if (node.status === STATUS_ROLLED_BACK || cascade.has(id)) return;
    cascade.add(id);
    for (const child of node.children) markCascade(child);
  };
  for (const id of billed) markCascade(id);

  const covered = new Map();
  const order = [];
  const visit = (id) => {
    const node = state.nodes[id];
    if (node.status === STATUS_ROLLED_BACK) return true;
    if (covered.has(id)) return covered.get(id);
    const children = activeChildren(state, id);
    let allChildrenCovered = children.length > 0;
    for (const child of children) {
      if (!visit(child)) allChildrenCovered = false;
    }
    const result = cascade.has(id) || allChildrenCovered;
    covered.set(id, result);
    if (result) order.push(id);
    return result;
  };
  visit(targetId);
  return { covered, order };
}

// Builds a rollback plan for `targetId` under `budget`.
// Returns { feasible, target, budget, totalCost, selected, selectedPaths,
//           concat, affected } where `selected` is the minimal billed node set
// and `affected` is every node that transitions, in execution order.
function planRollback(state, targetId, budget) {
  validateState(state);
  if (!Number.isInteger(budget) || budget < 0) {
    throw new StateError('budget must be a non-negative integer');
  }
  if (!Object.hasOwn(state.nodes, targetId)) {
    throw new StateError(`unknown node: ${targetId}`);
  }
  if (state.nodes[targetId].status === STATUS_ROLLED_BACK) {
    throw new StateError(`node already rolled back: ${targetId}`);
  }

  const cover = solveCover(state, targetId, new Map());
  const billed = new Set(cover.nodes);
  const { covered, order } = computeCoverage(state, targetId, billed);
  if (!covered.get(targetId)) {
    throw new StateError(`internal error: plan does not cover target ${targetId}`);
  }

  const selected = [...billed].sort((a, b) => byPath(state, a, b));
  return {
    feasible: cover.cost <= budget,
    target: targetId,
    budget,
    totalCost: cover.cost,
    selected,
    selectedPaths: selected.map((id) => state.nodes[id].path),
    concat: concatOf(state, selected),
    affected: order,
  };
}

// Applies a feasible plan to a copy of the state. Returns the new state and a
// certificate pairing every rolled-back node's old and new version hashes.
function applyRollback(state, plan) {
  const next = structuredClone(state);
  const entries = [];
  for (const id of plan.affected) {
    const node = next.nodes[id];
    if (node.status === STATUS_ROLLED_BACK) {
      throw new StateError(`node billed twice: ${id}`);
    }
    const oldHash = node.hash;
    const newHash = computeNewHash(id, oldHash);
    node.status = STATUS_ROLLED_BACK;
    node.hash = newHash;
    entries.push({ id, path: node.path, oldHash, newHash });
  }
  const certificate = {
    version: 1,
    target: plan.target,
    totalCost: plan.totalCost,
    selected: plan.selected,
    entries,
  };
  return { state: next, certificate };
}

// Verifies a certificate against a state: every certified node must currently
// be rolled back at exactly the certified new hash, and each new hash must be
// the deterministic rollback of the certified old hash.
function verifyCertificate(state, certificate) {
  const errors = [];
  if (!isNode(certificate) || certificate.version !== 1 || !Array.isArray(certificate.entries)) {
    return { ok: false, errors: ['malformed certificate'] };
  }
  for (const entry of certificate.entries) {
    if (!isNode(entry) || typeof entry.id !== 'string') {
      errors.push('malformed certificate entry');
      continue;
    }
    const node = state.nodes[entry.id];
    if (!node) {
      errors.push(`certificate references unknown node ${entry.id}`);
      continue;
    }
    if (node.status !== STATUS_ROLLED_BACK) {
      errors.push(`node ${entry.id} is not rolled back`);
    }
    if (node.hash !== entry.newHash) {
      errors.push(`node ${entry.id} hash mismatch: state has ${node.hash}`);
    }
    if (computeNewHash(entry.id, entry.oldHash) !== entry.newHash) {
      errors.push(`node ${entry.id} certificate hash chain is invalid`);
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  STATUS_ACTIVE,
  STATUS_ROLLED_BACK,
  StateError,
  computeNewHash,
  validateState,
  loadState,
  saveState,
  activeChildren,
  solveCover,
  computeCoverage,
  planRollback,
  applyRollback,
  verifyCertificate,
};
