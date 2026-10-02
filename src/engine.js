'use strict';

const { LineageError, CODES } = require('./errors');
const { createsCycle, affectedSubtree } = require('./dag');
const { emptyState, rootHash } = require('./state');
const { Store } = require('./store');
const { runSchedule } = require('./scheduler');

class Engine {
  constructor(store, state, dirty) {
    this.store = store;
    this.state = state;
    this.dirty = dirty;
  }

  static init(dir, config = {}) {
    if (!(config.cpus > 0) || !(config.mem > 0)) {
      throw new LineageError(CODES.INVALID, 'machine cpus/mem must be positive numbers');
    }
    const store = new Store(dir, config.hooks);
    const state = emptyState(config);
    store.commit(state); // generation 0
    return new Engine(store, state, false);
  }

  static open(dir, opts = {}) {
    const store = new Store(dir, opts.hooks);
    const recovered = store.recover();
    if (!recovered) {
      throw new LineageError(CODES.NOT_INITIALIZED, `no lineage state in ${dir}`);
    }
    return new Engine(store, recovered.state, recovered.dirty);
  }

  get root() {
    return rootHash(this.state);
  }

  _save() {
    this.dirty = true;
    this.store.saveWorking(this.state, true);
  }

  _validateSpec(id, spec) {
    for (const k of ['cpu', 'mem', 'bytes', 'cost']) {
      if (!(spec[k] >= 0)) {
        throw new LineageError(CODES.INVALID, `node ${id}: ${k} must be >= 0`);
      }
    }
    if (spec.cpu > this.state.machine.cpus || spec.mem > this.state.machine.mem) {
      throw new LineageError(
        CODES.RESOURCE_EXCEEDED,
        `node ${id} needs cpu=${spec.cpu} mem=${spec.mem}, beyond single machine `
          + `${this.state.machine.cpus} cpus / ${this.state.machine.mem} mem`,
      );
    }
    if (createsCycle(this.state.nodes, id, spec.deps)) {
      throw new LineageError(CODES.CYCLE, `dependency cycle involving ${id}`);
    }
    for (const d of spec.deps) {
      if (!this.state.nodes[d]) {
        throw new LineageError(CODES.NOT_FOUND, `dependency ${d} of ${id} not found`);
      }
    }
  }

  submit(id, spec = {}) {
    if (!id) throw new LineageError(CODES.INVALID, 'node id is required');
    if (this.state.nodes[id]) {
      throw new LineageError(CODES.DUPLICATE, `node ${id} already submitted`);
    }
    const node = {
      id,
      deps: [...(spec.deps ?? [])].sort(),
      cpu: spec.cpu ?? 1,
      mem: spec.mem ?? 0,
      bytes: spec.bytes ?? 0,
      cost: spec.cost ?? 1,
      owner: spec.owner ?? 'default',
      recomputable: spec.recomputable !== false,
      fails: spec.fails ?? 0,
      status: 'pending',
    };
    this._validateSpec(id, node);
    this.state.nodes[id] = node;
    this._save();
    return node;
  }

  // Invalidate exactly the subtree depending on `id`. Affected nodes go back
  // to pending (never "unsatisfiable"); unaffected materialized nodes keep
  // their evidence. Quota ledger entries survive, so recomputation is free.
  invalidate(id) {
    const nodes = this.state.nodes;
    if (!nodes[id]) throw new LineageError(CODES.NOT_FOUND, `node ${id} not found`);
    const affected = affectedSubtree(nodes, id);
    for (const nid of affected) {
      if (nodes[nid].status !== 'running') nodes[nid].status = 'pending';
    }
    this._save();
    return affected;
  }

  // Apply a corrected spec to `id`, then invalidate exactly the subtree
  // affected by the correction (computed on the pre-correction graph).
  correct(id, patch = {}) {
    const nodes = this.state.nodes;
    const node = nodes[id];
    if (!node) throw new LineageError(CODES.NOT_FOUND, `node ${id} not found`);
    const affected = affectedSubtree(nodes, id);
    const next = {
      ...node,
      deps: patch.deps ? [...patch.deps].sort() : node.deps,
      cpu: patch.cpu ?? node.cpu,
      mem: patch.mem ?? node.mem,
      bytes: patch.bytes ?? node.bytes,
      cost: patch.cost ?? node.cost,
      owner: patch.owner ?? node.owner,
    };
    this._validateSpec(id, next);
    nodes[id] = next;
    for (const nid of affected) {
      if (nodes[nid].status !== 'running') nodes[nid].status = 'pending';
    }
    this._save();
    return affected;
  }

  // Preemption only kills recomputable running nodes; materialized (done)
  // evidence is always preserved.
  preempt(id) {
    const node = this.state.nodes[id];
    if (!node) throw new LineageError(CODES.NOT_FOUND, `node ${id} not found`);
    if (node.status === 'running') {
      if (!node.recomputable) {
        throw new LineageError(
          CODES.NOT_RECOMPUTABLE,
          `node ${id} is not recomputable; refusing to preempt`,
        );
      }
      node.status = 'pending';
      this._save();
      return { id, preempted: true };
    }
    if (node.status === 'done') return { id, preempted: false, preserved: true };
    return { id, preempted: false };
  }

  schedule(opts = {}) {
    const result = runSchedule(this, opts);
    this._save();
    return { ...result, stateRoot: this.root };
  }

  commit() {
    if (!this.dirty) {
      throw new LineageError(CODES.DUPLICATE_COMMIT, 'nothing to commit: no changes since last commit');
    }
    this.state.generation += 1;
    const out = this.store.commit(this.state);
    this.dirty = false;
    return out;
  }

  undo() {
    const prev = this.store.undo();
    if (!prev) {
      throw new LineageError(CODES.NOT_FOUND, 'no previous generation to roll back to');
    }
    this.state = prev;
    this.dirty = false;
    return { generation: prev.generation, root: rootHash(prev) };
  }

  status() {
    return {
      generation: this.state.generation,
      root: this.root,
      dirty: this.dirty,
      completedBytes: { ...this.state.completedBytes },
      nodes: Object.fromEntries(
        Object.values(this.state.nodes).map((n) => [
          n.id,
          { status: n.status, owner: n.owner, deps: n.deps, bytes: n.bytes },
        ]),
      ),
    };
  }
}

module.exports = { Engine };
