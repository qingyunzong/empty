import { createHash } from 'node:crypto';

export const E_CYCLE = 'E_CYCLE';
export const E_REF = 'E_REF';
export const E_OP = 'E_OP';

export function cmpId(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export function canon(value) {
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canon(value[k])).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}

export function hashOf(value) {
  return createHash('sha256').update(canon(value)).digest('hex');
}

export function emptyState() {
  return { now: null, batches: new Map(), nodes: new Map() };
}

const NODE_KINDS = new Set(['derived', 'chart', 'conclusion']);

export function applyEvent(state, ev) {
  if (!ev || typeof ev.op !== 'string') return { code: E_OP, message: 'missing op' };
  switch (ev.op) {
    case 'setNow':
      state.now = ev.now ?? null;
      return null;
    case 'addBatch':
      state.batches.set(ev.id, {
        id: ev.id,
        expiresAt: ev.expiresAt ?? null,
        concentration: ev.concentration ?? null,
        status: ev.status ?? 'active',
        corrected: false,
      });
      return null;
    case 'correctConcentration': {
      const batch = state.batches.get(ev.id);
      if (!batch) return { code: E_REF, ref: ev.id };
      if (ev.concentration !== undefined) batch.concentration = ev.concentration;
      batch.corrected = true;
      return null;
    }
    case 'withdrawBatch': {
      const batch = state.batches.get(ev.id);
      if (!batch) return { code: E_REF, ref: ev.id };
      batch.status = 'withdrawn';
      return null;
    }
    case 'addResult':
      state.nodes.set(ev.id, {
        id: ev.id,
        kind: 'result',
        batchId: ev.batchId,
        protocolVersion: ev.protocolVersion ?? '',
        substitutes: [...(ev.substitutes ?? [])],
        dependsOn: [],
      });
      return null;
    case 'addNode': {
      if (!NODE_KINDS.has(ev.kind)) return { code: E_OP, message: 'unknown node kind: ' + ev.kind };
      state.nodes.set(ev.id, { id: ev.id, kind: ev.kind, dependsOn: [...(ev.dependsOn ?? [])] });
      return null;
    }
    case 'addSubstitute':
    case 'removeSubstitute': {
      const node = state.nodes.get(ev.id);
      if (!node || node.kind !== 'result') return { code: E_REF, ref: ev.id };
      if (ev.op === 'addSubstitute') {
        if (!node.substitutes.includes(ev.batchId)) node.substitutes.push(ev.batchId);
      } else {
        node.substitutes = node.substitutes.filter((s) => s !== ev.batchId);
      }
      return null;
    }
    case 'addDependency':
    case 'removeDependency': {
      const node = state.nodes.get(ev.id);
      if (!node) return { code: E_REF, ref: ev.id };
      if (ev.op === 'addDependency') {
        if (!node.dependsOn.includes(ev.dependsOn)) node.dependsOn.push(ev.dependsOn);
      } else {
        node.dependsOn = node.dependsOn.filter((d) => d !== ev.dependsOn);
      }
      return null;
    }
    default:
      return { code: E_OP, message: 'unknown op: ' + ev.op };
  }
}

export function replay(events, upto) {
  const state = emptyState();
  const limit = upto === undefined ? events.length : upto;
  for (let i = 0; i < limit; i++) applyEvent(state, events[i]);
  return state;
}

export function batchProblems(batch, now) {
  const problems = [];
  if (batch.status !== 'active') problems.push(batch.status === 'withdrawn' ? 'withdrawn' : 'inactive');
  if (batch.corrected) problems.push('corrected');
  if (batch.expiresAt && now && now >= batch.expiresAt) problems.push('expired');
  return problems;
}

function sortedIds(map) {
  return [...map.keys()].sort(cmpId);
}

function findRefError(state) {
  for (const id of sortedIds(state.nodes)) {
    const node = state.nodes.get(id);
    if (node.kind === 'result') {
      for (const ref of [node.batchId, ...node.substitutes]) {
        if (!state.batches.has(ref)) return { code: E_REF, node: id, ref };
      }
    }
    for (const dep of node.dependsOn ?? []) {
      if (!state.nodes.has(dep)) return { code: E_REF, node: id, ref: dep };
    }
  }
  return null;
}

function findCycle(state) {
  const color = new Map();
  const stack = [];
  const visit = (id) => {
    color.set(id, 1);
    stack.push(id);
    const deps = [...(state.nodes.get(id).dependsOn ?? [])].sort(cmpId);
    for (const dep of deps) {
      const c = color.get(dep) ?? 0;
      if (c === 0) {
        const found = visit(dep);
        if (found) return found;
      } else if (c === 1) {
        return stack.slice(stack.indexOf(dep)).concat(dep);
      }
    }
    stack.pop();
    color.set(id, 2);
    return null;
  };
  for (const id of sortedIds(state.nodes)) {
    if ((color.get(id) ?? 0) === 0) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

function topoOrder(state) {
  const order = [];
  const color = new Map();
  const visit = (id) => {
    color.set(id, 1);
    const deps = [...(state.nodes.get(id).dependsOn ?? [])].sort(cmpId);
    for (const dep of deps) if ((color.get(dep) ?? 0) === 0) visit(dep);
    color.set(id, 2);
    order.push(id);
  };
  for (const id of sortedIds(state.nodes)) if ((color.get(id) ?? 0) === 0) visit(id);
  return order;
}

function computeResultNode(state, node) {
  const candidates = [...new Set([node.batchId, ...node.substitutes])];
  const candInfo = candidates
    .map((c) => ({ id: c, problems: batchProblems(state.batches.get(c), state.now) }))
    .sort((a, b) => cmpId(a.id, b.id));
  let status;
  let chosenBatch = null;
  let invalidationPath = null;
  let cause = null;
  if (!node.protocolVersion) {
    status = 'invalid';
    cause = { type: 'empty_protocol' };
    invalidationPath = [node.id];
  } else {
    const valid = candInfo.filter((c) => c.problems.length === 0).map((c) => c.id);
    if (valid.length > 0) {
      status = 'valid';
      chosenBatch = valid[0];
    } else {
      status = 'invalid';
      cause = { type: 'batch', batches: candInfo };
      invalidationPath = [node.id];
    }
  }
  const hash = hashOf({
    id: node.id,
    kind: node.kind,
    protocolVersion: node.protocolVersion,
    candidates: candInfo,
    status,
    chosenBatch,
    invalidationPath,
  });
  return { status, chosenBatch, invalidationPath, cause, hash };
}

function computeDerivedNode(node, info) {
  const deps = [...node.dependsOn].sort(cmpId);
  const bad = deps.filter((d) => info.get(d).status !== 'valid');
  let status;
  let invalidationPath = null;
  let cause = null;
  if (bad.length === 0) {
    status = 'valid';
  } else {
    status = 'invalid';
    const src = bad[0];
    invalidationPath = [...info.get(src).invalidationPath, node.id];
    cause = { type: 'dependency', of: src };
  }
  const hash = hashOf({
    id: node.id,
    kind: node.kind,
    deps: deps.map((d) => info.get(d).hash),
    status,
    invalidationPath,
  });
  return { status, chosenBatch: null, invalidationPath, cause, hash };
}

export function evaluateState(state) {
  const refError = findRefError(state);
  if (refError) return { error: refError, status: null, nodes: {}, stateHash: null };
  const cycle = findCycle(state);
  if (cycle) return { error: { code: E_CYCLE, cycle }, status: null, nodes: {}, stateHash: null };

  const info = new Map();
  for (const id of topoOrder(state)) {
    const node = state.nodes.get(id);
    info.set(id, node.kind === 'result' ? computeResultNode(state, node) : computeDerivedNode(node, info));
  }

  const nodes = {};
  let allValid = true;
  for (const id of sortedIds(state.nodes)) {
    const inf = info.get(id);
    if (inf.status !== 'valid') allValid = false;
    nodes[id] = {
      status: inf.status,
      chosenBatch: inf.chosenBatch,
      invalidationPath: inf.invalidationPath,
      cause: inf.cause,
      certificate: {
        nodeId: id,
        status: inf.status,
        chosenBatch: inf.chosenBatch,
        invalidationPath: inf.invalidationPath,
        stateHash: inf.hash,
      },
    };
  }
  const stateHash = hashOf({
    now: state.now,
    nodes: [...info.entries()].map(([id, inf]) => [id, inf.hash]).sort((a, b) => cmpId(a[0], b[0])),
  });
  return { error: null, status: allValid ? 'valid' : 'invalid', nodes, stateHash };
}

function diffAffected(before, after) {
  const ids = new Set([...Object.keys(before.nodes ?? {}), ...Object.keys(after.nodes ?? {})]);
  if (before.error || after.error) return [...ids].sort(cmpId);
  const changed = [];
  for (const id of ids) {
    const a = before.nodes[id];
    const b = after.nodes[id];
    if (!a || !b || a.certificate.stateHash !== b.certificate.stateHash) changed.push(id);
  }
  return changed.sort(cmpId);
}

export class Lab {
  constructor() {
    this.events = [];
    this.cursor = 0;
  }

  state() {
    return replay(this.events, this.cursor);
  }

  evaluate() {
    return evaluateState(this.state());
  }

  apply(ev) {
    const before = this.evaluate();
    const err = applyEvent(this.state(), ev);
    if (err) return { ok: false, error: err };
    this.events.length = this.cursor;
    this.events.push(ev);
    this.cursor++;
    const evaluation = this.evaluate();
    return { ok: true, affected: diffAffected(before, evaluation), evaluation };
  }

  undo() {
    if (this.cursor === 0) return { ok: false, error: { code: E_OP, message: 'nothing to undo' } };
    const before = this.evaluate();
    this.cursor--;
    const evaluation = this.evaluate();
    return { ok: true, affected: diffAffected(before, evaluation), evaluation };
  }

  redo() {
    if (this.cursor >= this.events.length) return { ok: false, error: { code: E_OP, message: 'nothing to redo' } };
    const before = this.evaluate();
    this.cursor++;
    const evaluation = this.evaluate();
    return { ok: true, affected: diffAffected(before, evaluation), evaluation };
  }
}
