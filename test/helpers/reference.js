// Independent reference implementation: applies each transaction to a plain
// graph, then recomputes ALL derived values from scratch (clear + full
// recompute). Used to cross-check the incremental engine.
import { createHash } from 'node:crypto';

export const DERIVED_OPS = ['sum', 'min', 'max', 'avg', 'concat'];

function clone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function compute(op, values) {
  if (op === 'sum') {
    for (const v of values) {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('non-numeric');
    }
    return values.reduce((a, b) => a + b, 0);
  }
  if (op === 'min' || op === 'max' || op === 'avg') {
    if (values.length === 0) throw new Error('empty input');
    for (const v of values) {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('non-numeric');
    }
    if (op === 'min') return Math.min(...values);
    if (op === 'max') return Math.max(...values);
    return values.reduce((a, b) => a + b, 0) / values.length;
  }
  if (op === 'concat') {
    if (values.length === 0) return '';
    if (values.every((v) => typeof v === 'string')) return values.join('');
    if (values.every((v) => Array.isArray(v))) return values.flat();
    throw new Error('bad concat inputs');
  }
  throw new Error('unknown op');
}

export function makeState(initial) {
  const nodes = new Map();
  const edges = [];
  for (const spec of initial.nodes ?? []) {
    if (nodes.has(spec.id)) throw new Error('dup node');
    nodes.set(spec.id, {
      id: spec.id,
      kind: spec.kind,
      op: spec.kind === 'derived' ? spec.op : undefined,
      value: spec.kind === 'source' ? clone(spec.value ?? null) : null,
      blocked: false,
    });
  }
  for (const spec of initial.nodes ?? []) {
    for (const from of spec.inputs ?? []) edges.push({ from, to: spec.id });
  }
  for (const e of initial.edges ?? []) edges.push({ from: e.from, to: e.to });
  const state = { nodes, edges, version: 0, undo: [] };
  fullRecompute(state);
  return state;
}

function inputsOf(state, id) {
  return state.edges.filter((e) => e.to === id).map((e) => e.from).sort();
}

function reachable(state, from, to) {
  const stack = [from];
  const seen = new Set();
  while (stack.length) {
    const id = stack.pop();
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of state.edges) if (e.from === id) stack.push(e.to);
  }
  return false;
}

export function fullRecompute(state) {
  // Kahn waves over all derived nodes, ties by id ascending.
  const derived = [...state.nodes.values()].filter((n) => n.kind === 'derived');
  const indeg = new Map();
  for (const n of derived) {
    indeg.set(n.id, inputsOf(state, n.id).filter((f) => indegReady(state, f)).length);
  }
  function indegReady(st, fid) {
    return st.nodes.get(fid).kind === 'derived';
  }
  let wave = derived.filter((n) => indeg.get(n.id) === 0).map((n) => n.id).sort();
  const done = new Set();
  const errors = [];
  while (wave.length) {
    for (const id of wave) {
      done.add(id);
      const node = state.nodes.get(id);
      const ins = inputsOf(state, id).map((f) => state.nodes.get(f));
      if (ins.some((n) => n.blocked)) {
        node.blocked = true;
        node.value = null;
        errors.push({ code: 'E_DERIVE', node: id });
      } else {
        try {
          node.value = compute(node.op, ins.map((n) => n.value));
          node.blocked = false;
        } catch {
          node.blocked = true;
          node.value = null;
          errors.push({ code: 'E_DERIVE', node: id });
        }
      }
    }
    const next = [];
    for (const n of derived) {
      if (done.has(n.id)) continue;
      const preds = inputsOf(state, n.id).filter((f) => state.nodes.get(f).kind === 'derived');
      if (preds.every((p) => done.has(p))) next.push(n.id);
    }
    next.sort();
    wave = next;
  }
  return errors;
}

function canonical(state) {
  const nodes = [...state.nodes.values()]
    .map((n) => {
      const out = { id: n.id, kind: n.kind };
      if (n.kind === 'derived') out.op = n.op;
      out.value = clone(n.value);
      out.blocked = n.blocked;
      return out;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const edges = state.edges
    .map((e) => ({ from: e.from, to: e.to }))
    .sort((a, b) => (a.from + '>' + a.to).localeCompare(b.from + '>' + b.to));
  return { version: state.version, nodes, edges };
}

export function stateView(state) {
  return canonical(state);
}

export function certificateOf(state) {
  const c = canonical(state);
  const digest = createHash('sha256')
    .update(JSON.stringify({ nodes: c.nodes, edges: c.edges }))
    .digest('hex');
  return { version: state.version, digest };
}

function snapshotOf(state) {
  return clone(canonical(state));
}

function restore(state, snap) {
  state.nodes = new Map();
  for (const n of snap.nodes) {
    state.nodes.set(n.id, {
      id: n.id,
      kind: n.kind,
      op: n.kind === 'derived' ? n.op : undefined,
      value: clone(n.value),
      blocked: n.blocked,
    });
  }
  state.edges = snap.edges.map((e) => ({ from: e.from, to: e.to }));
}

function valuesEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Returns {status:'ok', diffs} or {status:'error', error:{code,...}}.
export function applyTransactionRef(state, tx) {
  const before = canonical(state);
  const undoBackup = state.undo.slice();
  const snap = snapshotOf(state);
  const fail = (code, message) => {
    restore(state, snap);
    state.undo = undoBackup;
    return { status: 'error', error: { code, message } };
  };
  for (const op of tx.ops ?? []) {
    if (op.type === 'setSource') {
      const n = state.nodes.get(op.node);
      if (!n || n.kind !== 'source') return fail('E_OP', 'bad setSource');
      n.value = clone(op.value);
    } else if (op.type === 'addEdge') {
      const from = state.nodes.get(op.from);
      const to = state.nodes.get(op.to);
      if (!from || !to) return fail('E_OP', 'unknown endpoint');
      if (to.kind !== 'derived') return fail('E_OP', 'target must be derived');
      if (state.edges.some((e) => e.from === op.from && e.to === op.to)) continue;
      if (op.from === op.to || reachable(state, op.to, op.from)) {
        return fail('E_CYCLE', `edge ${op.from} -> ${op.to} introduces a cycle`);
      }
      state.edges.push({ from: op.from, to: op.to });
    } else if (op.type === 'removeEdge') {
      if (!state.nodes.get(op.from) || !state.nodes.get(op.to)) return fail('E_OP', 'unknown endpoint');
      state.edges = state.edges.filter((e) => !(e.from === op.from && e.to === op.to));
    } else if (op.type === 'addNode') {
      const spec = op.node;
      if (state.nodes.has(spec.id)) return fail('E_OP', 'node exists');
      if (spec.kind === 'derived' && !DERIVED_OPS.includes(spec.op)) return fail('E_OP', 'bad op');
      state.nodes.set(spec.id, {
        id: spec.id,
        kind: spec.kind,
        op: spec.kind === 'derived' ? spec.op : undefined,
        value: spec.kind === 'source' ? clone(spec.value ?? null) : null,
        blocked: false,
      });
      for (const from of spec.inputs ?? []) {
        const f = state.nodes.get(from);
        if (!f) return fail('E_OP', 'unknown endpoint');
        if (from === spec.id || reachable(state, spec.id, from)) {
          return fail('E_CYCLE', `edge ${from} -> ${spec.id} introduces a cycle`);
        }
        state.edges.push({ from, to: spec.id });
      }
    } else if (op.type === 'removeNode') {
      if (!state.nodes.get(op.node)) return fail('E_OP', 'unknown node');
      state.nodes.delete(op.node);
      state.edges = state.edges.filter((e) => e.from !== op.node && e.to !== op.node);
    } else if (op.type === 'undo') {
      const top = state.undo[state.undo.length - 1];
      if (!top || top.tag !== op.tag) return fail('E_UNDO', `cannot undo tag ${op.tag}`);
      state.undo.pop();
      restore(state, top.snapshot);
    } else {
      return fail('E_OP', `unknown op ${op.type}`);
    }
  }
  fullRecompute(state);
  state.version += 1;
  if (tx.undoTag != null) state.undo.push({ tag: tx.undoTag, snapshot: snap });
  const after = canonical(state);
  const diffs = [];
  for (const n of after.nodes) {
    const b = before.nodes.find((x) => x.id === n.id);
    if (!b) continue;
    if (!valuesEqual(b.value, n.value) || b.blocked !== n.blocked) {
      diffs.push({
        node: n.id,
        before: { value: b.value, blocked: b.blocked },
        after: { value: n.value, blocked: n.blocked },
      });
    }
  }
  return { status: 'ok', diffs, certificate: certificateOf(state) };
}
