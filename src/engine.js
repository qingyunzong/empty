'use strict';

const { createHash } = require('node:crypto');
const {
  ID_RE,
  byRankThenId,
  listNodes,
  depsOf,
  computeNode,
} = require('./derive');

function sameOut(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return a.value === b.value && a.error === b.error && a.invalid === b.invalid;
}

function clone(o) {
  return o == null ? null : { value: o.value, error: o.error, invalid: o.invalid };
}

function hashOutputs(outputs) {
  const entries = [...outputs.keys()].sort().map((id) => [id, outputs.get(id)]);
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

class Engine {
  constructor() {
    this.state = { plates: new Map(), reps: new Map() };
    this.outputs = new Map();
    this.undoStack = [];
    this.redoStack = [];
    this.seq = 0;
  }

  _fail(message) {
    return { error: 'E_OP', message };
  }

  _repNodesFor(plate, well) {
    const ref = `${plate}/${well}`;
    const seeds = [];
    for (const [group, refs] of this.state.reps) {
      if (refs.includes(ref)) seeds.push(`repMean:${group}`, `repCV:${group}`);
    }
    return seeds;
  }

  // Mark the seed set dirty, propagate through dependents, recompute dirty
  // nodes in topological (rank) order, and emit diff + certificate.
  _recompute(seedIds, label, removedIds = []) {
    const diff = [];
    const removedNodes = [];
    for (const id of removedIds) {
      if (this.outputs.has(id)) {
        diff.push({ node: id, before: clone(this.outputs.get(id)), after: null });
        removedNodes.push(id);
      }
      this.outputs.delete(id);
    }

    const ids = listNodes(this.state);
    const existing = new Set(ids);
    const dependents = new Map();
    for (const id of ids) {
      for (const dep of depsOf(id, this.state)) {
        if (!dependents.has(dep)) dependents.set(dep, []);
        dependents.get(dep).push(id);
      }
    }

    const dirty = new Set();
    const stack = [...seedIds];
    while (stack.length) {
      const id = stack.pop();
      if (!existing.has(id) || dirty.has(id)) continue;
      dirty.add(id);
      for (const next of dependents.get(id) || []) stack.push(next);
    }

    const invalidated = [...dirty, ...removedNodes].sort(byRankThenId);
    const recomputeOrder = [...dirty].sort(byRankThenId);
    for (const id of recomputeOrder) {
      const before = this.outputs.has(id) ? clone(this.outputs.get(id)) : null;
      const after = computeNode(id, this.state, (d) => this.outputs.get(d));
      this.outputs.set(id, after);
      if (!sameOut(before, after)) {
        diff.push({ node: id, before, after: clone(after) });
      }
    }

    diff.sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));
    const certificate = {
      seq: ++this.seq,
      op: label,
      invalidated,
      changed: diff.map((d) => d.node),
      hash: hashOutputs(this.outputs),
    };
    return { diff, certificate };
  }

  _commit(label, mut) {
    const { seeds = [], removed = [] } = mut.apply();
    const { diff, certificate } = this._recompute(seeds, label, removed);
    this.undoStack.push({ label, mut });
    this.redoStack.length = 0;
    return { op: label, diff, certificate };
  }

  addPlate(plate) {
    if (!ID_RE.test(plate)) return this._fail(`invalid plate id: ${plate}`);
    if (this.state.plates.has(plate)) return this._fail(`plate exists: ${plate}`);
    const nodes = [`negCtrl:${plate}`, `posCtrl:${plate}`, `plateMean:${plate}`];
    return this._commit({ op: 'addPlate', plate }, {
      apply: () => {
        this.state.plates.set(plate, { wells: new Map(), neg: null, pos: null });
        return { seeds: nodes };
      },
      revert: () => {
        this.state.plates.delete(plate);
        return { removed: nodes };
      },
    });
  }

  addWell(plate, well, absorbance = 0) {
    const p = this.state.plates.get(plate);
    if (!p) return this._fail(`unknown plate: ${plate}`);
    if (!ID_RE.test(well)) return this._fail(`invalid well id: ${well}`);
    if (p.wells.has(well)) return this._fail(`well exists: ${plate}/${well}`);
    if (!Number.isFinite(absorbance)) return this._fail(`invalid absorbance: ${absorbance}`);
    const own = [`well:${plate}:${well}`, `corr:${plate}:${well}`, `ratio:${plate}:${well}`];
    const shared = [`negCtrl:${plate}`, `posCtrl:${plate}`, `plateMean:${plate}`];
    return this._commit({ op: 'addWell', plate, well, absorbance }, {
      apply: () => {
        p.wells.set(well, absorbance);
        return { seeds: [...own, ...shared, ...this._repNodesFor(plate, well)] };
      },
      revert: () => {
        p.wells.delete(well);
        return { seeds: [...shared, ...this._repNodesFor(plate, well)], removed: own };
      },
    });
  }

  removeWell(plate, well) {
    const p = this.state.plates.get(plate);
    if (!p) return this._fail(`unknown plate: ${plate}`);
    if (!p.wells.has(well)) return this._fail(`unknown well: ${plate}/${well}`);
    const old = p.wells.get(well);
    const own = [`well:${plate}:${well}`, `corr:${plate}:${well}`, `ratio:${plate}:${well}`];
    const shared = [`negCtrl:${plate}`, `posCtrl:${plate}`, `plateMean:${plate}`];
    return this._commit({ op: 'removeWell', plate, well }, {
      apply: () => {
        p.wells.delete(well);
        return { seeds: [...shared, ...this._repNodesFor(plate, well)], removed: own };
      },
      revert: () => {
        p.wells.set(well, old);
        return { seeds: [...own, ...shared, ...this._repNodesFor(plate, well)] };
      },
    });
  }

  setAbsorbance(plate, well, absorbance) {
    const p = this.state.plates.get(plate);
    if (!p) return this._fail(`unknown plate: ${plate}`);
    if (!p.wells.has(well)) return this._fail(`unknown well: ${plate}/${well}`);
    if (!Number.isFinite(absorbance)) return this._fail(`invalid absorbance: ${absorbance}`);
    const old = p.wells.get(well);
    const seeds = [`well:${plate}:${well}`];
    return this._commit({ op: 'setAbsorbance', plate, well, absorbance }, {
      apply: () => {
        p.wells.set(well, absorbance);
        return { seeds };
      },
      revert: () => {
        p.wells.set(well, old);
        return { seeds };
      },
    });
  }

  setControl(plate, kind, well) {
    const p = this.state.plates.get(plate);
    if (!p) return this._fail(`unknown plate: ${plate}`);
    if (kind !== 'neg' && kind !== 'pos') return this._fail(`invalid control kind: ${kind}`);
    if (well != null && !ID_RE.test(well)) return this._fail(`invalid well id: ${well}`);
    const old = p[kind];
    const seeds = [`${kind}Ctrl:${plate}`];
    return this._commit({ op: 'setControl', plate, kind, well }, {
      apply: () => {
        p[kind] = well;
        return { seeds };
      },
      revert: () => {
        p[kind] = old;
        return { seeds };
      },
    });
  }

  addReplicate(group, wells = []) {
    if (!ID_RE.test(group)) return this._fail(`invalid group id: ${group}`);
    if (this.state.reps.has(group)) return this._fail(`group exists: ${group}`);
    if (!Array.isArray(wells)) return this._fail('wells must be an array');
    if (new Set(wells).size !== wells.length) return this._fail('duplicate well refs');
    for (const ref of wells) {
      const [plate, well] = String(ref).split('/');
      const p = this.state.plates.get(plate);
      if (!p || !p.wells.has(well)) return this._fail(`unknown well ref: ${ref}`);
    }
    const nodes = [`repMean:${group}`, `repCV:${group}`];
    const init = [...wells];
    return this._commit({ op: 'addReplicate', group, wells: init }, {
      apply: () => {
        this.state.reps.set(group, [...init]);
        return { seeds: nodes };
      },
      revert: () => {
        this.state.reps.delete(group);
        return { removed: nodes };
      },
    });
  }

  removeReplicate(group) {
    const refs = this.state.reps.get(group);
    if (!refs) return this._fail(`unknown group: ${group}`);
    const init = [...refs];
    const nodes = [`repMean:${group}`, `repCV:${group}`];
    return this._commit({ op: 'removeReplicate', group }, {
      apply: () => {
        this.state.reps.delete(group);
        return { removed: nodes };
      },
      revert: () => {
        this.state.reps.set(group, [...init]);
        return { seeds: nodes };
      },
    });
  }

  moveWell(from, to, ref) {
    const src = this.state.reps.get(from);
    const dst = this.state.reps.get(to);
    if (!src) return this._fail(`unknown group: ${from}`);
    if (!dst) return this._fail(`unknown group: ${to}`);
    if (from === to) return this._fail('from and to are the same group');
    const idx = src.indexOf(ref);
    if (idx === -1) return this._fail(`well ${ref} not in group ${from}`);
    if (dst.includes(ref)) return this._fail(`well ${ref} already in group ${to}`);
    const seeds = [`repMean:${from}`, `repCV:${from}`, `repMean:${to}`, `repCV:${to}`];
    return this._commit({ op: 'moveWell', from, to, well: ref }, {
      apply: () => {
        src.splice(src.indexOf(ref), 1);
        dst.push(ref);
        return { seeds };
      },
      revert: () => {
        dst.splice(dst.indexOf(ref), 1);
        src.splice(idx, 0, ref);
        return { seeds };
      },
    });
  }

  undo() {
    const rec = this.undoStack.pop();
    if (!rec) return this._fail('nothing to undo');
    const { seeds = [], removed = [] } = rec.mut.revert();
    const label = { op: 'undo', of: rec.label };
    const { diff, certificate } = this._recompute(seeds, label, removed);
    this.redoStack.push(rec);
    return { op: label, diff, certificate };
  }

  redo() {
    const rec = this.redoStack.pop();
    if (!rec) return this._fail('nothing to redo');
    const { seeds = [], removed = [] } = rec.mut.apply();
    const label = { op: 'redo', of: rec.label };
    const { diff, certificate } = this._recompute(seeds, label, removed);
    this.undoStack.push(rec);
    return { op: label, diff, certificate };
  }

  getSnapshot() {
    const nodes = {};
    for (const id of [...this.outputs.keys()].sort()) nodes[id] = clone(this.outputs.get(id));
    return {
      hash: hashOutputs(this.outputs),
      invalid: Object.keys(nodes).filter((id) => nodes[id].invalid),
      errors: Object.keys(nodes).filter((id) => nodes[id].error),
      nodes,
    };
  }
}

module.exports = { Engine, hashOutputs, sameOut };
