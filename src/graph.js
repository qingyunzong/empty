import { createHash } from 'node:crypto';

export const DERIVED_OPS = ['sum', 'min', 'max', 'avg', 'concat'];

export class TxError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

export class DeriveError extends Error {}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function assertNumber(value, op) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DeriveError(`${op} requires numeric inputs, got ${JSON.stringify(value)}`);
  }
}

export function computeValue(op, values) {
  switch (op) {
    case 'sum': {
      for (const v of values) assertNumber(v, op);
      return values.reduce((a, b) => a + b, 0);
    }
    case 'min':
    case 'max':
    case 'avg': {
      if (values.length === 0) {
        throw new DeriveError(`${op} requires at least one input`);
      }
      for (const v of values) assertNumber(v, op);
      if (op === 'min') return Math.min(...values);
      if (op === 'max') return Math.max(...values);
      return values.reduce((a, b) => a + b, 0) / values.length;
    }
    case 'concat': {
      if (values.length === 0) return '';
      if (values.every((v) => typeof v === 'string')) return values.join('');
      if (values.every((v) => Array.isArray(v))) return values.flat();
      throw new DeriveError('concat requires all-string or all-array inputs');
    }
    default:
      throw new DeriveError(`unknown derived op: ${op}`);
  }
}

export class Engine {
  #nodes = new Map(); // id -> {id, kind, op, value, blocked}
  #inputs = new Map(); // id -> Set of from-ids
  #outputs = new Map(); // id -> Set of to-ids
  #version = 0;
  #undoStack = []; // {tag, snapshot}

  constructor(initialState = {}) {
    const nodes = initialState.nodes ?? [];
    const edges = initialState.edges ?? [];
    for (const spec of nodes) {
      this.#addNodeSpec(spec);
    }
    for (const spec of nodes) {
      for (const from of spec.inputs ?? []) {
        this.#addEdgeChecked(from, spec.id);
      }
    }
    for (const edge of edges) {
      this.#addEdgeChecked(edge.from, edge.to);
    }
    this.#recompute(new Set(this.#derivedIds()));
  }

  #getNode(id) {
    const node = this.#nodes.get(id);
    if (!node) throw new TxError('E_OP', `unknown node: ${id}`);
    return node;
  }

  #derivedIds() {
    const ids = [];
    for (const node of this.#nodes.values()) {
      if (node.kind === 'derived') ids.push(node.id);
    }
    return ids.sort();
  }

  #addNodeSpec(spec) {
    if (!spec || typeof spec.id !== 'string') {
      throw new TxError('E_OP', 'node spec requires a string id');
    }
    if (this.#nodes.has(spec.id)) {
      throw new TxError('E_OP', `node already exists: ${spec.id}`);
    }
    if (spec.kind === 'source') {
      this.#nodes.set(spec.id, {
        id: spec.id,
        kind: 'source',
        value: clone(spec.value ?? null),
        blocked: false,
      });
    } else if (spec.kind === 'derived') {
      if (!DERIVED_OPS.includes(spec.op)) {
        throw new TxError('E_OP', `invalid derived op for ${spec.id}: ${spec.op}`);
      }
      this.#nodes.set(spec.id, {
        id: spec.id,
        kind: 'derived',
        op: spec.op,
        value: null,
        blocked: false,
      });
    } else {
      throw new TxError('E_OP', `invalid node kind for ${spec.id}: ${spec.kind}`);
    }
    this.#inputs.set(spec.id, new Set());
    this.#outputs.set(spec.id, new Set());
  }

  #reachable(fromId, toId) {
    const stack = [fromId];
    const seen = new Set();
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === toId) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const next of this.#outputs.get(id) ?? []) stack.push(next);
    }
    return false;
  }

  #addEdgeChecked(fromId, toId) {
    const from = this.#getNode(fromId);
    const to = this.#getNode(toId);
    if (to.kind !== 'derived') {
      throw new TxError('E_OP', `edge target must be derived: ${toId}`);
    }
    if (this.#inputs.get(toId).has(fromId)) return false; // duplicate: no-op
    if (fromId === toId || this.#reachable(toId, fromId)) {
      throw new TxError('E_CYCLE', `edge ${fromId} -> ${toId} introduces a cycle`, {
        edge: { from: fromId, to: toId },
      });
    }
    this.#inputs.get(toId).add(from.id);
    this.#outputs.get(from.id).add(to.id);
    return true;
  }

  #removeEdge(fromId, toId) {
    this.#getNode(fromId);
    this.#getNode(toId);
    if (!this.#inputs.get(toId).has(fromId)) return false;
    this.#inputs.get(toId).delete(fromId);
    this.#outputs.get(fromId).delete(toId);
    return true;
  }

  #snapshot() {
    return {
      nodes: [...this.#nodes.values()].map((n) => ({ ...n, value: clone(n.value) })),
      edges: this.#edgeList(),
    };
  }

  #restore(snapshot) {
    this.#nodes = new Map();
    this.#inputs = new Map();
    this.#outputs = new Map();
    for (const node of snapshot.nodes) {
      this.#nodes.set(node.id, { ...node, value: clone(node.value) });
      this.#inputs.set(node.id, new Set());
      this.#outputs.set(node.id, new Set());
    }
    for (const { from, to } of snapshot.edges) {
      this.#inputs.get(to).add(from);
      this.#outputs.get(from).add(to);
    }
  }

  #edgeList() {
    const edges = [];
    for (const [to, froms] of this.#inputs) {
      for (const from of froms) edges.push({ from, to });
    }
    edges.sort((a, b) => (a.from + '>' + a.to).localeCompare(b.from + '>' + b.to));
    return edges;
  }

  // Recompute the given dirty derived nodes in deterministic dynamic
  // topological order: Kahn waves over the dirty subgraph, ties by id asc.
  #recompute(dirty) {
    const affected = [];
    const deriveErrors = [];
    const indeg = new Map();
    for (const id of dirty) {
      let count = 0;
      for (const from of this.#inputs.get(id)) {
        if (dirty.has(from)) count += 1;
      }
      indeg.set(id, count);
    }
    let wave = [...dirty].filter((id) => indeg.get(id) === 0).sort();
    const remaining = new Set(dirty);
    while (wave.length > 0) {
      for (const id of wave) {
        remaining.delete(id);
        affected.push(id);
        this.#recomputeNode(id, deriveErrors);
      }
      const next = [];
      for (const id of wave) {
        for (const to of this.#outputs.get(id)) {
          if (!remaining.has(to)) continue;
          indeg.set(to, indeg.get(to) - 1);
          if (indeg.get(to) === 0) next.push(to);
        }
      }
      next.sort();
      wave = next;
    }
    const blocked = [...this.#nodes.values()]
      .filter((n) => n.blocked)
      .map((n) => n.id)
      .sort();
    return { affected, deriveErrors, blocked };
  }

  #recomputeNode(id, deriveErrors) {
    const node = this.#nodes.get(id);
    const inputIds = [...this.#inputs.get(id)].sort();
    const inputNodes = inputIds.map((fid) => this.#nodes.get(fid));
    const blockedInput = inputNodes.find((n) => n.blocked);
    if (blockedInput) {
      node.blocked = true;
      node.value = null;
      deriveErrors.push({
        code: 'E_DERIVE',
        node: id,
        message: `input ${blockedInput.id} is blocked`,
      });
    } else {
      try {
        node.value = computeValue(node.op, inputNodes.map((n) => n.value));
        node.blocked = false;
      } catch (err) {
        if (!(err instanceof DeriveError)) throw err;
        node.blocked = true;
        node.value = null;
        deriveErrors.push({ code: 'E_DERIVE', node: id, message: err.message });
      }
    }
  }

  #canonical() {
    const nodes = [...this.#nodes.values()]
      .map((n) => {
        const out = { id: n.id, kind: n.kind };
        if (n.kind === 'derived') out.op = n.op;
        out.value = clone(n.value);
        out.blocked = n.blocked;
        return out;
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    return { nodes, edges: this.#edgeList() };
  }

  certificate() {
    const digest = createHash('sha256')
      .update(JSON.stringify(this.#canonical()))
      .digest('hex');
    return { version: this.#version, digest };
  }

  getState() {
    return { version: this.#version, ...this.#canonical() };
  }

  applyTransaction(tx) {
    const snapshot = this.#snapshot();
    const undoBackup = this.#undoStack.slice();
    const beforeMap = new Map(
      snapshot.nodes.map((n) => [n.id, { value: clone(n.value), blocked: n.blocked }]),
    );
    const roots = new Set();
    const changedSources = [];
    let fullDirty = false;
    try {
      for (const op of tx.ops ?? []) {
        switch (op.type) {
          case 'setSource': {
            const node = this.#getNode(op.node);
            if (node.kind !== 'source') {
              throw new TxError('E_OP', `setSource on non-source node: ${op.node}`);
            }
            if (!deepEqual(node.value, op.value)) {
              node.value = clone(op.value);
              roots.add(node.id);
              if (!changedSources.includes(node.id)) changedSources.push(node.id);
            }
            break;
          }
          case 'addEdge': {
            if (this.#addEdgeChecked(op.from, op.to)) roots.add(op.to);
            break;
          }
          case 'removeEdge': {
            if (this.#removeEdge(op.from, op.to)) roots.add(op.to);
            break;
          }
          case 'addNode': {
            this.#addNodeSpec(op.node);
            if (op.node.kind === 'derived') {
              roots.add(op.node.id);
              for (const from of op.node.inputs ?? []) {
                if (this.#addEdgeChecked(from, op.node.id)) roots.add(op.node.id);
              }
            }
            break;
          }
          case 'removeNode': {
            const node = this.#getNode(op.node);
            for (const to of [...this.#outputs.get(node.id)]) {
              this.#removeEdge(node.id, to);
              roots.add(to);
            }
            for (const from of [...this.#inputs.get(node.id)]) {
              this.#removeEdge(from, node.id);
            }
            this.#nodes.delete(node.id);
            this.#inputs.delete(node.id);
            this.#outputs.delete(node.id);
            roots.delete(node.id);
            break;
          }
          case 'undo': {
            const top = this.#undoStack[this.#undoStack.length - 1];
            if (!top || top.tag !== op.tag) {
              throw new TxError(
                'E_UNDO',
                top
                  ? `undo tag ${op.tag} is not the most recent (top: ${top.tag})`
                  : `no committed transaction with undoTag: ${op.tag}`,
              );
            }
            this.#undoStack.pop();
            this.#restore(top.snapshot);
            roots.clear();
            fullDirty = true;
            break;
          }
          default:
            throw new TxError('E_OP', `unknown op type: ${op.type}`);
        }
      }
    } catch (err) {
      if (err instanceof TxError) {
        this.#restore(snapshot);
        this.#undoStack = undoBackup;
        return {
          id: tx.id ?? null,
          status: 'error',
          error: { code: err.code, message: err.message, ...err.extra },
          state: this.getState(),
        };
      }
      throw err;
    }

    let dirty;
    if (fullDirty) {
      dirty = new Set(this.#derivedIds());
    } else {
      dirty = new Set();
      const stack = [];
      for (const id of roots) {
        const node = this.#nodes.get(id);
        if (!node) continue;
        if (node.kind === 'derived') dirty.add(id);
        if (!stack.includes(id)) {
          stack.push(id);
        }
      }
      while (stack.length > 0) {
        const id = stack.pop();
        for (const to of this.#outputs.get(id) ?? []) {
          if (!dirty.has(to)) {
            dirty.add(to);
            stack.push(to);
          }
        }
      }
    }
    const { affected, deriveErrors, blocked } = this.#recompute(dirty);
    const candidateIds = fullDirty
      ? [...this.#nodes.keys()].sort()
      : [...changedSources, ...affected];
    const diffs = [];
    for (const id of candidateIds) {
      const before = beforeMap.get(id);
      if (!before) continue;
      const node = this.#nodes.get(id);
      const after = { value: clone(node.value), blocked: node.blocked };
      if (!deepEqual(before, after)) diffs.push({ node: id, before, after });
    }
    this.#version += 1;
    if (tx.undoTag != null) {
      this.#undoStack.push({ tag: tx.undoTag, snapshot });
    }
    return {
      id: tx.id ?? null,
      status: 'ok',
      affected,
      diffs,
      blocked,
      deriveErrors,
      certificate: this.certificate(),
    };
  }
}

export function runRequest(request) {
  let engine;
  try {
    engine = new Engine(request.state ?? {});
  } catch (err) {
    if (err instanceof TxError) {
      return { error: { code: err.code, message: err.message, ...err.extra } };
    }
    throw err;
  }
  const results = [];
  for (const tx of request.transactions ?? []) {
    results.push(engine.applyTransaction(tx));
  }
  return { results, state: engine.getState(), certificate: engine.certificate() };
}
