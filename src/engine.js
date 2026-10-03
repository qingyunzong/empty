'use strict';

const { compute, buildSpecs } = require('./compute');
const { createModel, memberKey, applyToModel } = require('./model');

const NOOP = { type: 'noop' };

function noopResult(op) {
  return { inverse: NOOP, effective: NOOP };
}

// Execute a user op against the model. Returns { inverse, effective } where
// `inverse` restores the prior model state and `effective` is the op that
// actually mutated the model (NOOP when nothing changed).
function execOp(model, op) {
  switch (op.type) {
    case 'noop':
      return noopResult(op);
    case 'batch': {
      const inverses = [];
      const effs = [];
      for (const sub of op.ops) {
        const r = execOp(model, sub);
        inverses.unshift(r.inverse);
        effs.push(r.effective);
      }
      return { inverse: { type: 'batch', ops: inverses }, effective: { type: 'batch', ops: effs } };
    }
    case 'addPlate': {
      if (model.plates.has(op.plate)) return noopResult(op);
      applyToModel(model, op);
      return { inverse: { type: 'removePlate', plate: op.plate }, effective: op };
    }
    case 'removePlate': {
      const p = model.plates.get(op.plate);
      if (!p) return noopResult(op);
      const inv = [{ type: 'addPlate', plate: op.plate }];
      for (const well of [...p.wells.keys()].sort()) {
        inv.push({ type: 'setWell', plate: op.plate, well, value: p.wells.get(well) });
      }
      for (const kind of ['neg', 'pos']) {
        if (p.controls[kind] != null) inv.push({ type: 'setControl', plate: op.plate, kind, well: p.controls[kind] });
      }
      for (const group of [...model.groups.keys()].sort()) {
        for (const key of [...model.groups.get(group)].sort()) {
          const sep = key.indexOf('/');
          const pl = key.slice(0, sep);
          const w = key.slice(sep + 1);
          if (pl === op.plate && p.wells.has(w)) inv.push({ type: 'addToGroup', group, plate: pl, well: w });
        }
      }
      applyToModel(model, op);
      return { inverse: { type: 'batch', ops: inv }, effective: op };
    }
    case 'setWell': {
      const p = model.plates.get(op.plate);
      if (!p) throw new Error(`unknown plate: ${op.plate}`);
      const had = p.wells.has(op.well);
      const old = p.wells.get(op.well);
      if (had && old === op.value) return noopResult(op);
      applyToModel(model, op);
      const inverse = had
        ? { type: 'setWell', plate: op.plate, well: op.well, value: old }
        : { type: 'removeWell', plate: op.plate, well: op.well };
      return { inverse, effective: op };
    }
    case 'removeWell': {
      const p = model.plates.get(op.plate);
      if (!p) throw new Error(`unknown plate: ${op.plate}`);
      if (!p.wells.has(op.well)) return noopResult(op);
      const inv = [{ type: 'setWell', plate: op.plate, well: op.well, value: p.wells.get(op.well) }];
      const key = memberKey(op.plate, op.well);
      for (const group of [...model.groups.keys()].sort()) {
        if (model.groups.get(group).has(key)) inv.push({ type: 'addToGroup', group, plate: op.plate, well: op.well });
      }
      applyToModel(model, op);
      return { inverse: { type: 'batch', ops: inv }, effective: op };
    }
    case 'setControl': {
      const p = model.plates.get(op.plate);
      if (!p) throw new Error(`unknown plate: ${op.plate}`);
      if (op.kind !== 'neg' && op.kind !== 'pos') throw new Error(`bad control kind: ${op.kind}`);
      const old = p.controls[op.kind];
      const next = op.well == null ? null : op.well;
      if (old === next) return noopResult(op);
      applyToModel(model, op);
      return { inverse: { type: 'setControl', plate: op.plate, kind: op.kind, well: old }, effective: op };
    }
    case 'addGroup': {
      if (model.groups.has(op.group)) return noopResult(op);
      applyToModel(model, op);
      return { inverse: { type: 'removeGroup', group: op.group }, effective: op };
    }
    case 'removeGroup': {
      const members = model.groups.get(op.group);
      if (!members) return noopResult(op);
      const inv = [{ type: 'addGroup', group: op.group }];
      for (const key of [...members].sort()) {
        const sep = key.indexOf('/');
        inv.push({ type: 'addToGroup', group: op.group, plate: key.slice(0, sep), well: key.slice(sep + 1) });
      }
      applyToModel(model, op);
      return { inverse: { type: 'batch', ops: inv }, effective: op };
    }
    case 'addToGroup': {
      const g = model.groups.get(op.group);
      if (!g) throw new Error(`unknown group: ${op.group}`);
      const key = memberKey(op.plate, op.well);
      if (g.has(key)) return noopResult(op);
      applyToModel(model, op);
      return { inverse: { type: 'removeFromGroup', group: op.group, plate: op.plate, well: op.well }, effective: op };
    }
    case 'removeFromGroup': {
      const g = model.groups.get(op.group);
      if (!g) throw new Error(`unknown group: ${op.group}`);
      const key = memberKey(op.plate, op.well);
      if (!g.has(key)) return noopResult(op);
      applyToModel(model, op);
      return { inverse: { type: 'addToGroup', group: op.group, plate: op.plate, well: op.well }, effective: op };
    }
    case 'moveWell': {
      const from = op.from == null ? null : op.from;
      const to = op.to == null ? null : op.to;
      if (from === to) return noopResult(op);
      if (from != null && !model.groups.has(from)) throw new Error(`unknown group: ${from}`);
      if (to != null && !model.groups.has(to)) throw new Error(`unknown group: ${to}`);
      const key = memberKey(op.plate, op.well);
      const wasInFrom = from != null && model.groups.get(from).has(key);
      const wasInTo = to != null && model.groups.get(to).has(key);
      const willRemove = wasInFrom;
      const willAdd = to != null && !wasInTo;
      if (!willRemove && !willAdd) return noopResult(op);
      const inv = [];
      if (willAdd) inv.push({ type: 'removeFromGroup', group: to, plate: op.plate, well: op.well });
      if (willRemove) inv.push({ type: 'addToGroup', group: from, plate: op.plate, well: op.well });
      applyToModel(model, op);
      return { inverse: inv.length === 1 ? inv[0] : { type: 'batch', ops: inv }, effective: op };
    }
    default:
      throw new Error(`unknown op type: ${op.type}`);
  }
}

class Engine {
  constructor() {
    this.model = createModel();
    this.nodes = new Map(); // id -> { spec, specJson, deps, dependents, state }
    this.undoStack = []; // entries { effective, inverse }
    this.redoStack = [];
    this.seq = 0;
  }

  // Effective op log (undo pops, redo re-pushes). Feeding this to the
  // reference reducer reproduces the current model from scratch.
  history() {
    return this.undoStack.map((e) => e.effective);
  }

  apply(op) {
    if (op.type === 'undo') return this.#undo();
    if (op.type === 'redo') return this.#redo();
    const { inverse, effective } = execOp(this.model, op);
    this.undoStack.push({ effective, inverse });
    this.redoStack = [];
    return this.#recompute(op);
  }

  #undo() {
    const entry = this.undoStack.pop();
    if (!entry) return this.#recompute({ type: 'undo' });
    execOp(this.model, entry.inverse);
    this.redoStack.push(entry);
    return this.#recompute({ type: 'undo' });
  }

  #redo() {
    const entry = this.redoStack.pop();
    if (!entry) return this.#recompute({ type: 'redo' });
    execOp(this.model, entry.effective);
    this.undoStack.push(entry);
    return this.#recompute({ type: 'redo' });
  }

  snapshot() {
    const values = {};
    const invalid = [];
    const errors = {};
    for (const id of [...this.nodes.keys()].sort()) {
      const st = this.nodes.get(id).state;
      values[id] = st;
      if (st.invalid) invalid.push(id);
      if (st.error) errors[id] = st.reason;
    }
    return { values, invalid, errors };
  }

  #recompute(op) {
    const specs = buildSpecs(this.model);
    const changedMap = new Map();

    // Remove obsolete nodes.
    for (const id of [...this.nodes.keys()]) {
      if (!specs.has(id)) {
        changedMap.set(id, null);
        this.nodes.delete(id);
      }
    }

    // Create/update nodes; spec change (deps, raw value, mapping) => dirty.
    const dirty = new Set();
    for (const [id, spec] of specs) {
      const specJson = JSON.stringify(spec);
      let node = this.nodes.get(id);
      if (!node) {
        node = { spec, specJson, deps: spec.deps, dependents: new Set(), state: null };
        this.nodes.set(id, node);
        dirty.add(id);
      } else {
        node.spec = spec;
        node.deps = spec.deps;
        if (node.specJson !== specJson) {
          node.specJson = specJson;
          dirty.add(id);
        }
      }
    }

    // Rebuild reverse edges.
    for (const node of this.nodes.values()) node.dependents.clear();
    for (const [id, node] of this.nodes) {
      for (const d of node.deps) this.nodes.get(d).dependents.add(id);
    }

    // Propagate dirtiness to transitive dependents.
    const queue = [...dirty];
    while (queue.length) {
      const id = queue.pop();
      for (const dep of this.nodes.get(id).dependents) {
        if (!dirty.has(dep)) {
          dirty.add(dep);
          queue.push(dep);
        }
      }
    }

    // Evaluate dirty nodes only, dependencies first.
    const recomputed = [];
    const evalNode = (id) => {
      const node = this.nodes.get(id);
      if (!dirty.has(id)) return node.state;
      dirty.delete(id);
      recomputed.push(id);
      const depStates = new Map(node.spec.deps.map((d) => [d, evalNode(d)]));
      const prev = node.state;
      const next = compute(node.spec, depStates);
      node.state = next;
      if (JSON.stringify(prev) !== JSON.stringify(next)) changedMap.set(id, next);
      return next;
    };
    for (const id of [...this.nodes.keys()].sort()) evalNode(id);

    recomputed.sort();
    const changed = {};
    for (const id of [...changedMap.keys()].sort()) changed[id] = changedMap.get(id);

    const snap = this.snapshot();
    return {
      seq: ++this.seq,
      op,
      recomputed,
      changed,
      invalid: snap.invalid,
      errors: snap.errors,
    };
  }
}

module.exports = { Engine, execOp };
