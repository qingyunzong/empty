'use strict';

// Naive reference implementation: recomputes every calibrated value from
// scratch on every query. Used to validate the incremental engine.

const { createHash } = require('node:crypto');

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

class ReferenceChain {
  constructor() {
    this.sensors = new Map(); // id -> { raw, offset, scale, base }
    this.version = 0;
    this._undoStack = [];
    this._redoStack = [];
  }

  _snapshot() {
    return JSON.stringify({
      v: this.version,
      s: [...this.sensors].map(([id, s]) => [id, { ...s }]),
    });
  }

  _restore(snapshot) {
    const data = JSON.parse(snapshot);
    this.version = data.v;
    this.sensors = new Map(data.s);
  }

  _commit(mutate) {
    const snapshot = this._snapshot();
    const error = mutate();
    if (error !== null) return { ok: false, error };
    this._undoStack.push(snapshot);
    this._redoStack.length = 0;
    this.version += 1;
    return { ok: true };
  }

  addSensor(id, { raw, offset, scale }) {
    return this._commit(() => {
      if (this.sensors.has(id)) return 'E_STATE';
      this.sensors.set(id, { raw, offset, scale, base: null });
      return null;
    });
  }

  removeSensor(id) {
    return this._commit(() => {
      if (!this.sensors.has(id)) return 'E_UNKNOWN';
      this.sensors.delete(id);
      return null;
    });
  }

  setBase(id, base) {
    return this._commit(() => {
      const sensor = this.sensors.get(id);
      if (!sensor || !this.sensors.has(base)) return 'E_UNKNOWN';
      if (sensor.base !== null) return 'E_TOPO';
      for (let cur = base; cur !== null; ) {
        if (cur === id) return 'E_CYCLE';
        cur = this.sensors.get(cur).base;
      }
      sensor.base = base;
      return null;
    });
  }

  removeBase(id) {
    return this._commit(() => {
      const sensor = this.sensors.get(id);
      if (!sensor) return 'E_UNKNOWN';
      if (sensor.base === null) return 'E_STATE';
      sensor.base = null;
      return null;
    });
  }

  correctCoefficients(id, { offset, scale }) {
    return this._commit(() => {
      const sensor = this.sensors.get(id);
      if (!sensor) return 'E_UNKNOWN';
      if (offset !== undefined) sensor.offset = offset;
      if (scale !== undefined) sensor.scale = scale;
      return null;
    });
  }

  undo() {
    if (this._undoStack.length === 0) return { ok: false, error: 'E_STATE' };
    this._redoStack.push(this._snapshot());
    this._restore(this._undoStack.pop());
    return { ok: true };
  }

  redo() {
    if (this._redoStack.length === 0) return { ok: false, error: 'E_STATE' };
    this._undoStack.push(this._snapshot());
    this._restore(this._redoStack.pop());
    return { ok: true };
  }

  // Full enumeration: topological sort over the whole graph, then compute
  // every value from scratch with no caching.
  _computeAll() {
    const ids = [...this.sensors.keys()];
    const indegree = new Map(ids.map((id) => [id, 0]));
    const childrenOf = new Map(ids.map((id) => [id, []]));
    for (const id of ids) {
      const base = this.sensors.get(id).base;
      if (base !== null && this.sensors.has(base)) {
        indegree.set(id, indegree.get(id) + 1);
        childrenOf.get(base).push(id);
      }
    }
    const ready = ids.filter((id) => indegree.get(id) === 0).sort(cmpStr);
    const order = [];
    while (ready.length > 0) {
      const id = ready.shift();
      order.push(id);
      for (const child of childrenOf.get(id)) {
        indegree.set(child, indegree.get(child) - 1);
        if (indegree.get(child) === 0) {
          ready.push(child);
          ready.sort(cmpStr);
        }
      }
    }
    const out = new Map();
    for (const id of order) {
      const s = this.sensors.get(id);
      if (s.base === null) {
        out.set(id, { value: s.raw * s.scale + s.offset, confidence: 1, blocked: false });
      } else if (!out.has(s.base)) {
        out.set(id, { value: null, confidence: 0, blocked: true });
      } else {
        const b = out.get(s.base);
        if (b.blocked) {
          out.set(id, { value: null, confidence: 0, blocked: true });
        } else {
          out.set(id, { value: b.value * s.scale + s.offset, confidence: 1, blocked: false });
        }
      }
    }
    return { order, values: out };
  }

  getResult(id) {
    if (!this.sensors.has(id)) return { ok: false, error: 'E_UNKNOWN' };
    const { values } = this._computeAll();
    const entry = values.get(id);
    return {
      ok: true,
      result: { id, version: this.version, ...entry },
    };
  }

  getResults() {
    const { values } = this._computeAll();
    const results = {};
    for (const id of [...this.sensors.keys()].sort(cmpStr)) {
      results[id] = { id, version: this.version, ...values.get(id) };
    }
    return results;
  }

  getCertificate() {
    const { order } = this._computeAll();
    const coeffs = [...this.sensors]
      .map(([id, s]) => [id, s.offset, s.scale])
      .sort((a, b) => cmpStr(a[0], b[0]));
    const edges = [...this.sensors]
      .filter(([, s]) => s.base !== null)
      .map(([id, s]) => [id, s.base])
      .sort((a, b) => cmpStr(a[0], b[0]) || cmpStr(a[1], b[1]));
    return {
      version: this.version,
      coeffHash: sha256(JSON.stringify(coeffs)),
      topoHash: sha256(JSON.stringify(edges)),
      order,
    };
  }
}

module.exports = { ReferenceChain };
