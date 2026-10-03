'use strict';

const crypto = require('node:crypto');

const E_FINALIZED = 'E_FINALIZED';
const E_TS = 'E_TS';
const E_RANGE = 'E_RANGE';
const E_INVALID = 'E_INVALID';
const E_WINDOW = 'E_WINDOW';
const E_UNDO = 'E_UNDO';
const E_REDO = 'E_REDO';

const OPS = new Set(['set', 'offset', 'scale']);
const WINDOW_TYPES = new Set(['mean', 'var']);

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function fail(code, message) {
  return { ok: false, code, message, diff: [], affected: null };
}

class Series {
  constructor({ observations = [], windows = [], finalizeHorizon = -Infinity } = {}) {
    this.finalizeHorizon = finalizeHorizon;
    this.obs = [];
    this.windows = new Map();
    this.history = [];
    this.redoStack = [];
    for (const o of observations) {
      const res = this.addObservation(o);
      if (!res.ok) {
        const err = new Error(res.message);
        err.code = res.code;
        throw err;
      }
    }
    for (const w of windows) {
      const res = this.addWindow(w);
      if (!res.ok) {
        const err = new Error(res.message);
        err.code = res.code;
        throw err;
      }
    }
  }

  addObservation({ t, v } = {}) {
    if (!Number.isFinite(t) || !Number.isFinite(v)) {
      return fail(E_INVALID, 'observation requires finite t and v');
    }
    let lo = 0;
    let hi = this.obs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.obs[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    if (lo < this.obs.length && this.obs[lo].t === t) {
      return fail(E_TS, `duplicate observation timestamp ${t}`);
    }
    this.obs.splice(lo, 0, { t, v });
    const diff = [];
    for (const w of this.windows.values()) {
      diff.push(...this._invalidate(w, lo, this.obs.length - 1));
    }
    return { ok: true, diff, affected: affectedInterval(diff), certificate: this.certificate() };
  }

  addWindow({ id, type = 'mean', length } = {}) {
    if (typeof id !== 'string' || id.length === 0) return fail(E_INVALID, 'window requires an id');
    if (this.windows.has(id)) return fail(E_INVALID, `duplicate window id ${id}`);
    if (!WINDOW_TYPES.has(type)) return fail(E_INVALID, `unknown window type ${type}`);
    if (!Number.isInteger(length) || length < 0) return fail(E_INVALID, 'window length must be a non-negative integer');
    const w = { id, type, length, outputs: new Map() };
    this.windows.set(id, w);
    const diff = this._invalidate(w, 0, this.obs.length - 1);
    return { ok: true, diff, affected: affectedInterval(diff), certificate: this.certificate() };
  }

  setWindowLength(id, length) {
    const w = this.windows.get(id);
    if (!w) return fail(E_WINDOW, `unknown window ${id}`);
    if (!Number.isInteger(length) || length < 0) return fail(E_INVALID, 'window length must be a non-negative integer');
    w.length = length;
    // Dependency rebuild: every output of this window is potentially affected.
    const diff = this._invalidate(w, 0, this.obs.length - 1, { rebuild: true });
    return { ok: true, diff, affected: affectedInterval(diff), certificate: this.certificate() };
  }

  applyCorrection(correction = {}) {
    const { targetTs, op, value, reason, ts } = correction;
    if (!Number.isFinite(ts)) return fail(E_INVALID, 'correction requires a finite ts');
    if (typeof reason !== 'string' || reason.length === 0) return fail(E_INVALID, 'correction requires a reason');
    if (!OPS.has(op)) return fail(E_INVALID, `unknown op ${op}`);
    if (!Number.isFinite(value)) return fail(E_INVALID, 'correction requires a finite value');
    if (!Number.isFinite(targetTs)) return fail(E_RANGE, `no observation at t=${targetTs}`);
    const index = this.obs.findIndex((o) => o.t === targetTs);
    if (index === -1) return fail(E_RANGE, `no observation at t=${targetTs}`);
    if (targetTs < this.finalizeHorizon) {
      return fail(E_FINALIZED, `observation at t=${targetTs} is before finalizeHorizon ${this.finalizeHorizon}`);
    }
    const prevValue = this.obs[index].v;
    let newValue;
    if (op === 'set') newValue = value;
    else if (op === 'offset') newValue = prevValue + value;
    else newValue = prevValue * value;
    const entry = { correction: { targetTs, op, value, reason, ts }, index, prevValue, newValue };
    const result = this._commit(entry);
    this.history.push(entry);
    this.redoStack.length = 0;
    return result;
  }

  applyCorrections(corrections) {
    const ordered = corrections
      .map((c, i) => ({ c, i }))
      .sort((a, b) => (a.c.ts ?? 0) - (b.c.ts ?? 0) || a.i - b.i)
      .map(({ c }) => c);
    return ordered.map((c) => this.applyCorrection(c));
  }

  undo() {
    const entry = this.history.pop();
    if (!entry) return fail(E_UNDO, 'nothing to undo');
    this.obs[entry.index].v = entry.prevValue;
    const diff = this._invalidateAt(entry.index);
    this.redoStack.push(entry);
    return { ok: true, undone: entry.correction, diff, affected: affectedInterval(diff), certificate: this.certificate() };
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return fail(E_REDO, 'nothing to redo');
    this.obs[entry.index].v = entry.newValue;
    const diff = this._invalidateAt(entry.index);
    this.history.push(entry);
    return { ok: true, redone: entry.correction, diff, affected: affectedInterval(diff), certificate: this.certificate() };
  }

  _commit(entry) {
    this.obs[entry.index].v = entry.newValue;
    const diff = this._invalidateAt(entry.index);
    return { ok: true, applied: entry.correction, diff, affected: affectedInterval(diff), certificate: this.certificate() };
  }

  _invalidateAt(index) {
    const diff = [];
    for (const w of this.windows.values()) {
      diff.push(...this._invalidate(w, index, index + Math.max(w.length - 1, 0)));
    }
    return diff;
  }

  _invalidate(w, lo, hi, { rebuild = false } = {}) {
    const diff = [];
    const n = this.obs.length;
    const start = Math.max(lo, 0);
    const end = Math.min(hi, n - 1);
    const seen = new Set();
    for (let j = start; j <= end; j++) {
      const t = this.obs[j].t;
      seen.add(t);
      const oldV = w.outputs.has(t) ? w.outputs.get(t) : null;
      const newV = this._computeOutput(w, j);
      if (newV === undefined) {
        if (oldV !== null) {
          w.outputs.delete(t);
          diff.push({ window: w.id, endTs: t, old: oldV, new: null });
        }
        continue;
      }
      if (oldV === null || oldV !== newV) {
        w.outputs.set(t, newV);
        diff.push({ window: w.id, endTs: t, old: oldV, new: newV });
      }
    }
    if (rebuild) {
      for (const [t, oldV] of [...w.outputs]) {
        if (!seen.has(t)) {
          w.outputs.delete(t);
          diff.push({ window: w.id, endTs: t, old: oldV, new: null });
        }
      }
    }
    diff.sort((a, b) => (a.window < b.window ? -1 : a.window > b.window ? 1 : a.endTs - b.endTs));
    return diff;
  }

  _computeOutput(w, j) {
    const L = w.length;
    if (L <= 0 || j < L - 1 || j >= this.obs.length) return undefined;
    let sum = 0;
    for (let k = j - L + 1; k <= j; k++) sum += this.obs[k].v;
    const mean = sum / L;
    if (w.type === 'mean') return mean;
    let sq = 0;
    for (let k = j - L + 1; k <= j; k++) {
      const d = this.obs[k].v - mean;
      sq += d * d;
    }
    return sq / L;
  }

  windowOutputs(id) {
    const w = this.windows.get(id);
    if (!w) return null;
    return [...w.outputs.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([endTs, value]) => ({ endTs, value }));
  }

  state() {
    return {
      finalizeHorizon: this.finalizeHorizon,
      observations: this.obs.map((o) => ({ t: o.t, v: o.v })),
      windows: [...this.windows.values()].map((w) => ({
        id: w.id,
        type: w.type,
        length: w.length,
        outputs: this.windowOutputs(w.id),
      })),
      historyDepth: this.history.length,
      redoDepth: this.redoStack.length,
    };
  }

  certificate() {
    const { finalizeHorizon, observations, windows } = this.state();
    return crypto.createHash('sha256').update(canonical({ finalizeHorizon, observations, windows })).digest('hex');
  }
}

function affectedInterval(diff) {
  if (diff.length === 0) return null;
  let from = Infinity;
  let to = -Infinity;
  for (const d of diff) {
    if (d.endTs < from) from = d.endTs;
    if (d.endTs > to) to = d.endTs;
  }
  return { from, to };
}

// Reference implementation: full recompute of every window from scratch.
function fullRecompute(observations, windows) {
  const out = {};
  for (const w of windows) {
    const pts = [];
    const L = w.length;
    if (L > 0) {
      for (let j = L - 1; j < observations.length; j++) {
        let sum = 0;
        for (let k = j - L + 1; k <= j; k++) sum += observations[k].v;
        const mean = sum / L;
        let value = mean;
        if (w.type === 'var') {
          let sq = 0;
          for (let k = j - L + 1; k <= j; k++) {
            const d = observations[k].v - mean;
            sq += d * d;
          }
          value = sq / L;
        }
        pts.push({ endTs: observations[j].t, value });
      }
    }
    out[w.id] = pts;
  }
  return out;
}

module.exports = {
  Series,
  fullRecompute,
  canonical,
  affectedInterval,
  E_FINALIZED,
  E_TS,
  E_RANGE,
  E_INVALID,
  E_WINDOW,
  E_UNDO,
  E_REDO,
};
