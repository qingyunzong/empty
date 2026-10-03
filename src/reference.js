'use strict';

// Enumeration reference implementation.
//
// Independent of the incremental engine's recompute strategy: after every
// transaction it CLEARS all derived values and recomputes the whole graph
// from scratch over a freshly computed topological order (DFS based).
// Used by the acceptance tests to cross-check values, diff sets and
// certificates produced by the incremental engine.

const { OPS, evaluate, certificate } = require('./common');
const { createState, serialize, snapshot, restore, diffViews } = require('./engine');

// DFS-based topological order; deterministic (node ids visited ascending,
// inputs visited ascending). Returns null on cycle.
function topoFull(state) {
  const order = [];
  const mark = new Map(); // 1 = in stack, 2 = done
  const visit = (id) => {
    const m = mark.get(id) || 0;
    if (m === 2) return true;
    if (m === 1) return false;
    mark.set(id, 1);
    const ins = [...(state.inputs.get(id) || [])].sort();
    for (const f of ins) {
      if (!visit(f)) return false;
    }
    mark.set(id, 2);
    order.push(id);
    return true;
  };
  for (const id of [...state.nodes.keys()].sort()) {
    if (!visit(id)) return null;
  }
  return order;
}

// Clear every derived node, then recompute all of them from scratch.
function recomputeAll(state) {
  const order = topoFull(state);
  if (!order) return { error: { code: 'E_CYCLE', message: 'graph contains a cycle' } };
  const errors = [];
  for (const id of order) {
    const n = state.nodes.get(id);
    if (n.kind !== 'derived') continue;
    n.value = null;
    n.blocked = false;
    const ins = [...(state.inputs.get(id) || [])].sort();
    const values = [];
    let blocked = false;
    for (const f of ins) {
      const fn = state.nodes.get(f);
      if (fn.blocked) blocked = true;
      values.push(fn.value);
    }
    if (blocked) { n.blocked = true; continue; }
    const r = evaluate(n.op, values);
    if (r.ok) n.value = r.value;
    else {
      n.blocked = true;
      errors.push({ code: 'E_DERIVE', node: id, message: r.reason });
    }
  }
  return { errors };
}

function addNodeRef(state, spec) {
  if (!spec || typeof spec.id !== 'string') {
    return { code: 'E_BAD_OP', message: 'node spec requires a string id' };
  }
  if (state.nodes.has(spec.id)) {
    return { code: 'E_BAD_OP', message: `duplicate node ${spec.id}` };
  }
  if (spec.kind === 'source') {
    state.nodes.set(spec.id, {
      id: spec.id, kind: 'source', op: null,
      value: spec.value === undefined ? null : spec.value, blocked: false,
    });
    return null;
  }
  if (spec.kind === 'derived') {
    if (!OPS.has(spec.op)) {
      return { code: 'E_BAD_OP', message: `unknown derive op ${spec.op}` };
    }
    state.nodes.set(spec.id, {
      id: spec.id, kind: 'derived', op: spec.op, value: null, blocked: false,
    });
    return null;
  }
  return { code: 'E_BAD_OP', message: `unknown node kind ${spec.kind}` };
}

// Add edge, then detect a cycle via a fresh full topological sort.
function addEdgeRef(state, from, to) {
  const fromNode = state.nodes.get(from);
  const toNode = state.nodes.get(to);
  if (!fromNode) return { code: 'E_UNKNOWN_NODE', message: `no node ${from}` };
  if (!toNode) return { code: 'E_UNKNOWN_NODE', message: `no node ${to}` };
  if (toNode.kind !== 'derived') {
    return { code: 'E_BAD_OP', message: `node ${to} is not derived and cannot take inputs` };
  }
  let ins = state.inputs.get(to);
  if (!ins) { ins = new Set(); state.inputs.set(to, ins); }
  if (ins.has(from)) return null;
  ins.add(from);
  if (!topoFull(state)) {
    return { code: 'E_CYCLE', message: `edge ${from} -> ${to} introduces a cycle`, edge: { from, to } };
  }
  return null;
}

function applyTransactionRef(state, tx) {
  const preSnap = snapshot(state);
  const preLog = state.undoLog;
  const preView = serialize(state);
  let fatal = null;

  for (const op of (tx && tx.ops) || []) {
    let err = null;
    if (op && op.type === 'setSource') {
      const n = state.nodes.get(op.node);
      if (!n) err = { code: 'E_UNKNOWN_NODE', message: `no node ${op.node}` };
      else if (n.kind !== 'source') err = { code: 'E_BAD_OP', message: `node ${op.node} is not a source` };
      else n.value = op.value === undefined ? null : op.value;
    } else if (op && op.type === 'addEdge') {
      err = addEdgeRef(state, op.from, op.to);
    } else if (op && op.type === 'removeEdge') {
      const ins = state.inputs.get(op.to);
      if (ins) ins.delete(op.from);
    } else if (op && op.type === 'addNode') {
      err = addNodeRef(state, op.node);
      if (!err) {
        for (const f of op.node.inputs || []) {
          err = addEdgeRef(state, f, op.node.id);
          if (err) break;
        }
      }
    } else if (op && op.type === 'removeNode') {
      if (!state.nodes.has(op.node)) {
        err = { code: 'E_UNKNOWN_NODE', message: `no node ${op.node}` };
      } else {
        state.nodes.delete(op.node);
        state.inputs.delete(op.node);
        for (const s of state.inputs.values()) s.delete(op.node);
      }
    } else if (op && op.type === 'undo') {
      if (op.undoTag === undefined || op.undoTag === null) {
        err = { code: 'E_BAD_OP', message: 'undo op requires undoTag' };
      } else {
        const idx = state.undoLog.findIndex((e) => e.tag === op.undoTag);
        if (idx === -1) {
          err = { code: 'E_UNDO_TAG', message: `no recorded transaction for undoTag ${op.undoTag}` };
        } else {
          restore(state, state.undoLog[idx].snapshot);
          state.undoLog = state.undoLog.slice(0, idx);
        }
      }
    } else {
      err = { code: 'E_BAD_OP', message: `unknown op type ${op && op.type}` };
    }
    if (err) { fatal = err; break; }
  }

  if (fatal) {
    restore(state, preSnap);
    state.undoLog = preLog;
    const view = serialize(state);
    return {
      id: (tx && tx.id) ?? null,
      ok: false,
      error: fatal,
      version: state.version,
      certificate: certificate(view),
      affected: [],
      errors: [],
      state: view,
    };
  }

  const full = recomputeAll(state);
  if (full.error) {
    restore(state, preSnap);
    state.undoLog = preLog;
    const view = serialize(state);
    return {
      id: (tx && tx.id) ?? null,
      ok: false,
      error: full.error,
      version: state.version,
      certificate: certificate(view),
      affected: [],
      errors: [],
      state: view,
    };
  }

  state.version += 1;
  if (tx && tx.undoTag !== undefined && tx.undoTag !== null) {
    state.undoLog.push({ tag: tx.undoTag, snapshot: preSnap });
  }
  const postView = serialize(state);
  return {
    id: (tx && tx.id) ?? null,
    ok: true,
    version: state.version,
    certificate: certificate(postView),
    affected: diffViews(preView, postView),
    errors: full.errors,
  };
}

function runRequestReference(req) {
  if (!req || typeof req !== 'object') {
    return { ok: false, error: { code: 'E_BAD_REQUEST', message: 'request must be a JSON object' }, results: [] };
  }
  const state = createState();
  const init = req.state || {};
  const fail = (err) => ({
    ok: false,
    error: err,
    results: [],
    final: { version: state.version, certificate: certificate(serialize(state)), state: serialize(state) },
  });
  for (const spec of init.nodes || []) {
    const err = addNodeRef(state, spec);
    if (err) return fail(err);
  }
  for (const spec of init.nodes || []) {
    for (const f of spec.inputs || []) {
      const err = addEdgeRef(state, f, spec.id);
      if (err) return fail(err);
    }
  }
  for (const e of init.edges || []) {
    const err = addEdgeRef(state, e.from, e.to);
    if (err) return fail(err);
  }
  const full = recomputeAll(state);
  if (full.error) return fail(full.error);

  const results = [];
  for (const tx of req.transactions || []) {
    results.push(applyTransactionRef(state, tx));
  }
  const res = {
    ok: true,
    results,
    final: { version: state.version, certificate: certificate(serialize(state)), state: serialize(state) },
  };
  if (full.errors.length) res.initialErrors = full.errors;
  return res;
}

module.exports = { runRequestReference, recomputeAll, topoFull };
