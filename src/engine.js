'use strict';

// Incremental dependency-graph engine.
//
// State: nodes (source | derived), directed edges from input -> derived node.
// Derived values are recomputed incrementally: invalidation propagates only
// along out-edges from changed nodes, recomputation follows a deterministic
// topological order (ready set ordered by node id ascending).

const { OPS, evaluate, certificate } = require('./common');

function createState() {
  return {
    version: 0,
    nodes: new Map(),    // id -> { id, kind: 'source'|'derived', op, value, blocked }
    inputs: new Map(),   // derived id -> Set of input node ids
    outputs: new Map(),  // node id -> Set of dependent derived ids
    undoLog: [],         // [{ tag, snapshot }]
  };
}

function getOutputs(state, id) {
  let s = state.outputs.get(id);
  if (!s) { s = new Set(); state.outputs.set(id, s); }
  return s;
}

function addNodeRaw(state, spec) {
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
  } else if (spec.kind === 'derived') {
    if (!OPS.has(spec.op)) {
      return { code: 'E_BAD_OP', message: `unknown derive op ${spec.op}` };
    }
    state.nodes.set(spec.id, {
      id: spec.id, kind: 'derived', op: spec.op, value: null, blocked: false,
    });
  } else {
    return { code: 'E_BAD_OP', message: `unknown node kind ${spec.kind}` };
  }
  return null;
}

// Is `target` reachable from `start` following out-edges?
function reachable(state, start, target) {
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const id = stack.pop();
    for (const next of state.outputs.get(id) || []) {
      if (next === target) return true;
      if (!seen.has(next)) { seen.add(next); stack.push(next); }
    }
  }
  return false;
}

function addEdgeRaw(state, from, to) {
  const fromNode = state.nodes.get(from);
  const toNode = state.nodes.get(to);
  if (!fromNode) return { code: 'E_UNKNOWN_NODE', message: `no node ${from}` };
  if (!toNode) return { code: 'E_UNKNOWN_NODE', message: `no node ${to}` };
  if (toNode.kind !== 'derived') {
    return { code: 'E_BAD_OP', message: `node ${to} is not derived and cannot take inputs` };
  }
  let ins = state.inputs.get(to);
  if (!ins) { ins = new Set(); state.inputs.set(to, ins); }
  if (ins.has(from)) return null; // already present: no-op
  if (from === to || reachable(state, to, from)) {
    return { code: 'E_CYCLE', message: `edge ${from} -> ${to} introduces a cycle`, edge: { from, to } };
  }
  ins.add(from);
  getOutputs(state, from).add(to);
  return null;
}

function removeNodeRaw(state, id) {
  const ins = state.inputs.get(id);
  if (ins) {
    for (const f of ins) {
      const outs = state.outputs.get(f);
      if (outs) outs.delete(id);
    }
    state.inputs.delete(id);
  }
  const outs = [...(state.outputs.get(id) || [])];
  for (const o of outs) {
    const oIns = state.inputs.get(o);
    if (oIns) oIns.delete(id);
  }
  state.outputs.delete(id);
  state.nodes.delete(id);
  return outs;
}

// Deterministic topological order (Kahn; ready set ordered by id ascending,
// so same-level ties resolve by id). Returns null if the graph has a cycle.
function topoOrder(state) {
  const indeg = new Map();
  for (const id of state.nodes.keys()) indeg.set(id, 0);
  for (const [to, froms] of state.inputs) {
    if (indeg.has(to)) indeg.set(to, froms.size);
  }
  const ready = [...state.nodes.keys()].filter((id) => indeg.get(id) === 0).sort();
  const order = [];
  while (ready.length) {
    ready.sort();
    const id = ready.shift();
    order.push(id);
    for (const next of state.outputs.get(id) || []) {
      const d = indeg.get(next) - 1;
      indeg.set(next, d);
      if (d === 0) ready.push(next);
    }
  }
  return order.length === state.nodes.size ? order : null;
}

// Recompute one derived node from current inputs (ids sorted ascending).
function computeNode(state, id, errors) {
  const node = state.nodes.get(id);
  const ins = [...(state.inputs.get(id) || [])].sort();
  const values = [];
  let inputBlocked = false;
  for (const f of ins) {
    const fn = state.nodes.get(f);
    if (fn.blocked) inputBlocked = true;
    values.push(fn.value);
  }
  if (inputBlocked) {
    node.blocked = true;
    node.value = null;
    return;
  }
  const r = evaluate(node.op, values);
  if (r.ok) {
    node.value = r.value;
    node.blocked = false;
  } else {
    node.value = null;
    node.blocked = true;
    errors.push({ code: 'E_DERIVE', node: id, message: r.reason });
  }
}

function fullRecompute(state) {
  const order = topoOrder(state);
  if (!order) return { error: { code: 'E_CYCLE', message: 'initial graph contains a cycle' } };
  const errors = [];
  for (const id of order) {
    if (state.nodes.get(id).kind === 'derived') computeNode(state, id, errors);
  }
  return { errors };
}

function snapshot(state) {
  return {
    nodes: [...state.nodes.values()].map((n) => ({ ...n })),
    inputs: [...state.inputs].map(([k, s]) => [k, [...s]]),
  };
}

function restore(state, snap) {
  state.nodes = new Map(snap.nodes.map((n) => [n.id, { ...n }]));
  state.inputs = new Map(snap.inputs.map(([k, v]) => [k, new Set(v)]));
  state.outputs = new Map();
  for (const [to, froms] of state.inputs) {
    for (const f of froms) getOutputs(state, f).add(to);
  }
}

// Serializable state view; also the input to the version certificate.
function serialize(state) {
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const nodes = [...state.nodes.values()].map((n) => {
    const o = { id: n.id, kind: n.kind, value: n.value, blocked: n.blocked };
    if (n.kind === 'derived') o.op = n.op;
    return o;
  }).sort((a, b) => cmp(a.id, b.id));
  const edges = [];
  for (const [to, froms] of state.inputs) {
    for (const from of froms) edges.push({ from, to });
  }
  edges.sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to));
  return { version: state.version, nodes, edges };
}

// Value/blocked diffs between two serialized views, sorted by node id.
function diffViews(pre, post) {
  const preMap = new Map(pre.nodes.map((n) => [n.id, n]));
  const postMap = new Map(post.nodes.map((n) => [n.id, n]));
  const ids = new Set([...preMap.keys(), ...postMap.keys()]);
  const out = [];
  for (const id of [...ids].sort()) {
    const a = preMap.get(id);
    const b = postMap.get(id);
    if (a && b && a.value === b.value && a.blocked === b.blocked) continue;
    out.push({
      node: id,
      before: a ? { value: a.value, blocked: a.blocked } : null,
      after: b ? { value: b.value, blocked: b.blocked } : null,
    });
  }
  return out;
}

function applyOp(state, op, dirty) {
  switch (op && op.type) {
    case 'setSource': {
      const n = state.nodes.get(op.node);
      if (!n) return { code: 'E_UNKNOWN_NODE', message: `no node ${op.node}` };
      if (n.kind !== 'source') {
        return { code: 'E_BAD_OP', message: `node ${op.node} is not a source` };
      }
      n.value = op.value === undefined ? null : op.value;
      dirty.add(op.node);
      return null;
    }
    case 'addEdge': {
      const err = addEdgeRaw(state, op.from, op.to);
      if (err) return err;
      dirty.add(op.to);
      return null;
    }
    case 'removeEdge': {
      const ins = state.inputs.get(op.to);
      if (ins && ins.has(op.from)) {
        ins.delete(op.from);
        const outs = state.outputs.get(op.from);
        if (outs) outs.delete(op.to);
        dirty.add(op.to);
      }
      return null;
    }
    case 'addNode': {
      const err = addNodeRaw(state, op.node);
      if (err) return err;
      dirty.add(op.node.id);
      for (const f of op.node.inputs || []) {
        const e2 = addEdgeRaw(state, f, op.node.id);
        if (e2) return e2;
        dirty.add(op.node.id);
      }
      return null;
    }
    case 'removeNode': {
      if (!state.nodes.has(op.node)) {
        return { code: 'E_UNKNOWN_NODE', message: `no node ${op.node}` };
      }
      const outs = removeNodeRaw(state, op.node);
      for (const o of outs) dirty.add(o);
      dirty.delete(op.node);
      return null;
    }
    case 'undo': {
      if (op.undoTag === undefined || op.undoTag === null) {
        return { code: 'E_BAD_OP', message: 'undo op requires undoTag' };
      }
      const idx = state.undoLog.findIndex((e) => e.tag === op.undoTag);
      if (idx === -1) {
        return { code: 'E_UNDO_TAG', message: `no recorded transaction for undoTag ${op.undoTag}` };
      }
      // Restore graph and values to before the earliest transaction carrying
      // this tag (equivalent to undoing all of them in reverse order).
      restore(state, state.undoLog[idx].snapshot);
      state.undoLog = state.undoLog.slice(0, idx);
      dirty.clear();
      for (const [id, n] of state.nodes) {
        if (n.kind === 'derived') dirty.add(id);
      }
      return null;
    }
    default:
      return { code: 'E_BAD_OP', message: `unknown op type ${op && op.type}` };
  }
}

function applyTransaction(state, tx) {
  const preSnap = snapshot(state);
  const preLog = state.undoLog;
  const preView = serialize(state);
  const dirty = new Set();
  let fatal = null;

  for (const op of (tx && tx.ops) || []) {
    const err = applyOp(state, op, dirty);
    if (err) { fatal = err; break; }
  }

  if (fatal) {
    // Roll back: the transaction must not partially take effect.
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
      recomputed: [],
      errors: [],
      state: view,
    };
  }

  // Invalidation propagates only along out-edges of dirty nodes.
  const invalid = new Set();
  const stack = [...dirty];
  while (stack.length) {
    const id = stack.pop();
    const n = state.nodes.get(id);
    if (n && n.kind === 'derived') invalid.add(id);
    for (const next of state.outputs.get(id) || []) {
      if (!invalid.has(next)) { invalid.add(next); stack.push(next); }
    }
  }
  const order = topoOrder(state) || [];
  const recomputed = order.filter(
    (id) => invalid.has(id) && state.nodes.get(id).kind === 'derived',
  );
  const errors = [];
  for (const id of recomputed) computeNode(state, id, errors);

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
    recomputed,
    errors,
  };
}

function loadError(err, state) {
  return {
    ok: false,
    error: err,
    results: [],
    final: { version: state.version, certificate: certificate(serialize(state)), state: serialize(state) },
  };
}

function runRequest(req) {
  if (!req || typeof req !== 'object') {
    return { ok: false, error: { code: 'E_BAD_REQUEST', message: 'request must be a JSON object' }, results: [] };
  }
  const state = createState();
  const init = req.state || {};
  for (const spec of init.nodes || []) {
    const err = addNodeRaw(state, spec);
    if (err) return loadError(err, state);
  }
  for (const spec of init.nodes || []) {
    for (const f of spec.inputs || []) {
      const err = addEdgeRaw(state, f, spec.id);
      if (err) return loadError(err, state);
    }
  }
  for (const e of init.edges || []) {
    const err = addEdgeRaw(state, e.from, e.to);
    if (err) return loadError(err, state);
  }
  const full = fullRecompute(state);
  if (full.error) return loadError(full.error, state);

  const results = [];
  for (const tx of req.transactions || []) {
    results.push(applyTransaction(state, tx));
  }
  const res = {
    ok: true,
    results,
    final: { version: state.version, certificate: certificate(serialize(state)), state: serialize(state) },
  };
  if (full.errors.length) res.initialErrors = full.errors;
  return res;
}

module.exports = {
  createState, addNodeRaw, addEdgeRaw, removeNodeRaw, topoOrder,
  fullRecompute, snapshot, restore, serialize, diffViews,
  applyTransaction, runRequest,
};
