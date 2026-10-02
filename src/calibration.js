'use strict';

const { createHash } = require('node:crypto');

const E_TOPO = 'E_TOPO';
const E_CYCLE = 'E_CYCLE';
const E_UNKNOWN = 'E_UNKNOWN';
const E_STATE = 'E_STATE';

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Incremental maintenance of a sensor observation calibration chain.
 *
 * Each sensor has a raw reading, an offset and a scale. A sensor may
 * reference at most one calibration base. Calibrated values are computed
 * along the reference chain by repeatedly applying y = x * scale + offset,
 * where x is the base's calibrated value, or the sensor's own raw reading
 * when the sensor has no base.
 *
 * A sensor whose base is missing, or whose base is blocked, is blocked:
 * its confidence is 0 and its calibrated value is null.
 */
class CalibrationChain {
  constructor() {
    this.sensors = new Map(); // id -> { raw, offset, scale, base }
    this.children = new Map(); // baseId -> Set<childId> (baseId may not exist yet)
    this.cache = new Map(); // id -> { value, confidence, blocked }
    this.version = 0;
    this.stats = { recomputed: 0 };
    this._undoStack = [];
    this._redoStack = [];
  }

  // ---- internal helpers -------------------------------------------------

  _childrenOf(id) {
    const set = this.children.get(id);
    return set ? [...set] : [];
  }

  _descendants(seedIds) {
    const seen = new Set();
    const queue = [...seedIds];
    while (queue.length > 0) {
      const id = queue.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      for (const child of this._childrenOf(id)) queue.push(child);
    }
    return seen;
  }

  _topoOrder(ids) {
    const set = new Set(ids);
    const indegree = new Map();
    for (const id of set) indegree.set(id, 0);
    for (const id of set) {
      const base = this.sensors.get(id).base;
      if (base !== null && set.has(base)) indegree.set(id, indegree.get(id) + 1);
    }
    const ready = [...set].filter((id) => indegree.get(id) === 0).sort(cmpStr);
    const order = [];
    while (ready.length > 0) {
      const id = ready.shift();
      order.push(id);
      for (const child of this._childrenOf(id)) {
        if (!set.has(child)) continue;
        indegree.set(child, indegree.get(child) - 1);
        if (indegree.get(child) === 0) {
          ready.push(child);
          ready.sort(cmpStr);
        }
      }
    }
    return order;
  }

  _computeOne(id) {
    const sensor = this.sensors.get(id);
    const entry = this.cache.get(id);
    if (sensor.base === null) {
      entry.value = sensor.raw * sensor.scale + sensor.offset;
      entry.confidence = 1;
      entry.blocked = false;
    } else if (!this.sensors.has(sensor.base)) {
      entry.value = null;
      entry.confidence = 0;
      entry.blocked = true;
    } else {
      const baseEntry = this.cache.get(sensor.base);
      if (baseEntry.blocked) {
        entry.value = null;
        entry.confidence = 0;
        entry.blocked = true;
      } else {
        entry.value = baseEntry.value * sensor.scale + sensor.offset;
        entry.confidence = 1;
        entry.blocked = false;
      }
    }
    this.stats.recomputed += 1;
  }

  // Recompute only the transitive closure of sensors affected by a change.
  _recompute(seedIds) {
    const affected = new Set();
    for (const id of this._descendants(seedIds)) {
      if (this.sensors.has(id)) affected.add(id);
    }
    for (const id of this._topoOrder(affected)) this._computeOne(id);
  }

  _linkBase(id, base) {
    if (!this.children.has(base)) this.children.set(base, new Set());
    this.children.get(base).add(id);
  }

  _unlinkBase(id, base) {
    const set = this.children.get(base);
    if (set) {
      set.delete(id);
      if (set.size === 0) this.children.delete(base);
    }
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
    this.children = new Map();
    this.cache = new Map();
    for (const [id, sensor] of this.sensors) {
      this.cache.set(id, { value: null, confidence: 0, blocked: true });
      if (sensor.base !== null) this._linkBase(id, sensor.base);
    }
    this._recompute([...this.sensors.keys()]);
  }

  // Run a mutation; on success record history, bump version, clear redo.
  _commit(mutate) {
    const snapshot = this._snapshot();
    const error = mutate();
    if (error !== null) return { ok: false, error };
    this._undoStack.push(snapshot);
    this._redoStack.length = 0;
    this.version += 1;
    return { ok: true };
  }

  // ---- mutations ----------------------------------------------------------

  addSensor(id, { raw, offset, scale }) {
    return this._commit(() => {
      if (this.sensors.has(id)) return E_STATE;
      this.sensors.set(id, { raw, offset, scale, base: null });
      this.cache.set(id, { value: null, confidence: 0, blocked: true });
      this._recompute([id]); // also unblocks children that referenced a missing base
      return null;
    });
  }

  removeSensor(id) {
    return this._commit(() => {
      const sensor = this.sensors.get(id);
      if (!sensor) return E_UNKNOWN;
      const affected = this._descendants([id]);
      affected.delete(id);
      if (sensor.base !== null) this._unlinkBase(id, sensor.base);
      this.sensors.delete(id);
      this.cache.delete(id);
      this._recompute([...affected]);
      return null;
    });
  }

  setBase(id, base) {
    return this._commit(() => {
      const sensor = this.sensors.get(id);
      if (!sensor || !this.sensors.has(base)) return E_UNKNOWN;
      if (sensor.base !== null) return E_TOPO;
      // Cycle check: walk the ancestor chain of base; reaching id closes a loop.
      for (let cur = base; cur !== null; ) {
        if (cur === id) return E_CYCLE;
        cur = this.sensors.get(cur).base;
      }
      sensor.base = base;
      this._linkBase(id, base);
      this._recompute([id]);
      return null;
    });
  }

  removeBase(id) {
    return this._commit(() => {
      const sensor = this.sensors.get(id);
      if (!sensor) return E_UNKNOWN;
      if (sensor.base === null) return E_STATE;
      this._unlinkBase(id, sensor.base);
      sensor.base = null;
      this._recompute([id]);
      return null;
    });
  }

  correctCoefficients(id, { offset, scale }) {
    return this._commit(() => {
      const sensor = this.sensors.get(id);
      if (!sensor) return E_UNKNOWN;
      if (offset !== undefined) sensor.offset = offset;
      if (scale !== undefined) sensor.scale = scale;
      this._recompute([id]); // invalidation propagates along transitive closure
      return null;
    });
  }

  // ---- undo / redo --------------------------------------------------------

  undo() {
    if (this._undoStack.length === 0) return { ok: false, error: E_STATE };
    this._redoStack.push(this._snapshot());
    this._restore(this._undoStack.pop());
    return { ok: true };
  }

  redo() {
    if (this._redoStack.length === 0) return { ok: false, error: E_STATE };
    this._undoStack.push(this._snapshot());
    this._restore(this._redoStack.pop());
    return { ok: true };
  }

  // ---- queries ------------------------------------------------------------

  getResult(id) {
    const entry = this.cache.get(id);
    if (!entry) return { ok: false, error: E_UNKNOWN };
    return {
      ok: true,
      result: {
        id,
        version: this.version,
        value: entry.value,
        confidence: entry.confidence,
        blocked: entry.blocked,
      },
    };
  }

  getResults() {
    const results = {};
    for (const id of [...this.sensors.keys()].sort(cmpStr)) {
      results[id] = this.getResult(id).result;
    }
    return results;
  }

  getCertificate() {
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
      order: this._topoOrder([...this.sensors.keys()]),
    };
  }
}

module.exports = {
  CalibrationChain,
  E_TOPO,
  E_CYCLE,
  E_UNKNOWN,
  E_STATE,
};
