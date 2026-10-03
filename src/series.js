'use strict';

const crypto = require('node:crypto');

const ERRORS = Object.freeze({
  FINALIZED: 'E_FINALIZED',
  TS: 'E_TS',
  RANGE: 'E_RANGE',
  INVALID: 'E_INVALID',
  WINDOW: 'E_WINDOW',
  NODE: 'E_NODE',
  UNDO_EMPTY: 'E_UNDO_EMPTY',
  REDO_EMPTY: 'E_REDO_EMPTY',
});

const OPS = new Set(['set', 'offset', 'scale']);
const NODE_TYPES = new Set(['mean', 'variance']);

function canonical(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function certificateOf(payload) {
  return crypto.createHash('sha256').update(canonical(payload)).digest('hex');
}

class Series {
  constructor(options = {}) {
    const horizon = options.finalizeHorizon;
    this.finalizeHorizon = Number.isFinite(horizon) ? horizon : -Infinity;
    this.obs = [];
    this.nodes = new Map();
    this.undoStack = [];
    this.redoStack = [];
    this.log = [];
  }

  _lowerBound(ts) {
    let lo = 0;
    let hi = this.obs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.obs[mid].ts < ts) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  _computeAt(node, index) {
    const L = node.window;
    let sum = 0;
    for (let k = index - L + 1; k <= index; k++) sum += this.obs[k].value;
    const mean = sum / L;
    if (node.type === 'mean') return mean;
    let acc = 0;
    for (let k = index - L + 1; k <= index; k++) {
      const d = this.obs[k].value - mean;
      acc += d * d;
    }
    return acc / L;
  }

  _affectedIndices(node, changedIndices) {
    const n = this.obs.length;
    const L = node.window;
    const set = new Set();
    for (const i of changedIndices) {
      const from = Math.max(L - 1, i);
      const to = Math.min(n - 1, i + L - 1);
      for (let j = from; j <= to; j++) set.add(j);
    }
    return set;
  }

  _recompute(changedIndices) {
    const diffs = [];
    let recomputed = 0;
    let minIndex = Infinity;
    let maxIndex = -Infinity;
    for (const node of this.nodes.values()) {
      const targets = this._affectedIndices(node, changedIndices);
      if (targets.size === 0) continue;
      const changes = [];
      const sorted = [...targets].sort((a, b) => a - b);
      for (const j of sorted) {
        const oldValue = node.outputs[j];
        const newValue = this._computeAt(node, j);
        recomputed += 1;
        if (j < minIndex) minIndex = j;
        if (j > maxIndex) maxIndex = j;
        if (!Object.is(oldValue, newValue)) {
          node.outputs[j] = newValue;
          changes.push({ index: j, ts: this.obs[j].ts, old: oldValue, new: newValue });
        }
      }
      if (changes.length > 0) diffs.push({ node: node.id, changes });
    }
    const affected = recomputed === 0 ? null : {
      startIndex: minIndex,
      endIndex: maxIndex,
      startTs: this.obs[minIndex].ts,
      endTs: this.obs[maxIndex].ts,
    };
    return { diffs, affected, recomputed };
  }

  _rebuildNode(node) {
    const n = this.obs.length;
    const old = node.outputs;
    const next = new Array(n).fill(null);
    for (let i = node.window - 1; i < n; i++) next[i] = this._computeAt(node, i);
    node.outputs = next;
    const changes = [];
    const len = Math.max(old.length, next.length);
    for (let i = 0; i < len; i++) {
      const o = i < old.length ? old[i] : null;
      const v = i < next.length ? next[i] : null;
      if (!Object.is(o, v)) {
        changes.push({ index: i, ts: i < n ? this.obs[i].ts : null, old: o, new: v });
      }
    }
    return changes;
  }

  _intervalAll() {
    if (this.obs.length === 0) return null;
    return {
      startIndex: 0,
      endIndex: this.obs.length - 1,
      startTs: this.obs[0].ts,
      endTs: this.obs[this.obs.length - 1].ts,
    };
  }

  _result(report) {
    return { ok: true, ...report, certificate: this.certificate() };
  }

  addObservation(ts, value) {
    if (!Number.isFinite(ts) || !Number.isFinite(value)) return { ok: false, error: ERRORS.INVALID };
    const idx = this._lowerBound(ts);
    if (idx < this.obs.length && this.obs[idx].ts === ts) return { ok: false, error: ERRORS.TS };
    this.obs.splice(idx, 0, { ts, value });
    const diffs = [];
    let recomputed = 0;
    for (const node of this.nodes.values()) {
      const changes = this._rebuildNode(node);
      recomputed += Math.max(0, this.obs.length - node.window + 1);
      if (changes.length > 0) diffs.push({ node: node.id, changes });
    }
    return this._result({ index: idx, diffs, affected: this._intervalAll(), recomputed });
  }

  addNode(spec) {
    if (!spec || typeof spec.id !== 'string' || spec.id.length === 0) return { ok: false, error: ERRORS.INVALID };
    if (!NODE_TYPES.has(spec.type)) return { ok: false, error: ERRORS.INVALID };
    if (!Number.isInteger(spec.window) || spec.window < 1) return { ok: false, error: ERRORS.WINDOW };
    if (this.nodes.has(spec.id)) return { ok: false, error: ERRORS.NODE };
    const node = { id: spec.id, type: spec.type, window: spec.window, outputs: [] };
    this.nodes.set(node.id, node);
    const changes = this._rebuildNode(node);
    return this._result({
      diffs: changes.length > 0 ? [{ node: node.id, changes }] : [],
      affected: this._intervalAll(),
      recomputed: Math.max(0, this.obs.length - node.window + 1),
    });
  }

  setWindow(id, window) {
    const node = this.nodes.get(id);
    if (!node) return { ok: false, error: ERRORS.NODE };
    if (!Number.isInteger(window) || window < 1) return { ok: false, error: ERRORS.WINDOW };
    if (window === node.window) return this._result({ diffs: [], affected: null, recomputed: 0 });
    node.window = window;
    const changes = this._rebuildNode(node);
    return this._result({
      diffs: changes.length > 0 ? [{ node: node.id, changes }] : [],
      affected: this._intervalAll(),
      recomputed: Math.max(0, this.obs.length - node.window + 1),
    });
  }

  setFinalizeHorizon(horizon) {
    if (horizon !== null && !Number.isFinite(horizon)) return { ok: false, error: ERRORS.INVALID };
    this.finalizeHorizon = horizon === null ? -Infinity : horizon;
    return this._result({ diffs: [], affected: null, recomputed: 0 });
  }

  _validateCorrection(c) {
    if (!c || typeof c !== 'object') return ERRORS.INVALID;
    if (!OPS.has(c.op)) return ERRORS.INVALID;
    if (!Number.isFinite(c.value)) return ERRORS.INVALID;
    if (!Number.isFinite(c.ts)) return ERRORS.INVALID;
    if (typeof c.reason !== 'string' || c.reason.length === 0) return ERRORS.INVALID;
    if (!Number.isFinite(c.cts)) return ERRORS.INVALID;
    return null;
  }

  _applyOpValue(op, value, current) {
    if (op === 'set') return value;
    if (op === 'offset') return current + value;
    return current * value;
  }

  applyCorrection(c) {
    const res = this.applyCorrections([c]);
    const first = res.results[0];
    if (first && !first.ok) return { ok: false, error: first.error, certificate: res.certificate };
    return res;
  }

  applyCorrections(list) {
    const items = Array.isArray(list) ? list : [list];
    const prepared = items.map((c, order) => ({ c, order, shapeError: this._validateCorrection(c) }));
    const located = prepared
      .filter((p) => !p.shapeError)
      .map((p) => {
        const idx = this._lowerBound(p.c.ts);
        if (idx >= this.obs.length || this.obs[idx].ts !== p.c.ts) return { ...p, error: ERRORS.RANGE };
        if (p.c.ts < this.finalizeHorizon) return { ...p, error: ERRORS.FINALIZED };
        return { ...p, index: idx };
      });
    located.sort((a, b) => (a.c.cts - b.c.cts) || (a.order - b.order));
    const changed = new Set();
    const txs = [];
    for (const p of located) {
      if (p.error) continue;
      const oldValue = this.obs[p.index].value;
      const newValue = this._applyOpValue(p.c.op, p.c.value, oldValue);
      this.obs[p.index].value = newValue;
      txs.push({ correction: p.c, index: p.index, oldValue, newValue });
      changed.add(p.index);
      this.log.push({ op: p.c.op, ts: p.c.ts, value: p.c.value, reason: p.c.reason, cts: p.c.cts });
    }
    const report = changed.size > 0
      ? this._recompute(changed)
      : { diffs: [], affected: null, recomputed: 0 };
    if (txs.length > 0) {
      this.undoStack.push(txs);
      this.redoStack = [];
    }
    const byOrder = new Map();
    for (const p of prepared) {
      if (p.shapeError) byOrder.set(p.order, { ok: false, error: p.shapeError });
    }
    for (const p of located) {
      byOrder.set(p.order, p.error ? { ok: false, error: p.error } : { ok: true });
    }
    const results = prepared.map((p) => byOrder.get(p.order));
    return this._result({ ...report, results, applied: txs.length });
  }

  undo() {
    const txs = this.undoStack.pop();
    if (!txs) return { ok: false, error: ERRORS.UNDO_EMPTY };
    const changed = new Set();
    for (let k = txs.length - 1; k >= 0; k--) {
      const tx = txs[k];
      this.obs[tx.index].value = tx.oldValue;
      changed.add(tx.index);
      this.log.pop();
    }
    const report = this._recompute(changed);
    this.redoStack.push(txs);
    return this._result(report);
  }

  redo() {
    const txs = this.redoStack.pop();
    if (!txs) return { ok: false, error: ERRORS.REDO_EMPTY };
    const changed = new Set();
    for (const tx of txs) {
      this.obs[tx.index].value = tx.newValue;
      changed.add(tx.index);
      this.log.push({ op: tx.correction.op, ts: tx.correction.ts, value: tx.correction.value, reason: tx.correction.reason, cts: tx.correction.cts });
    }
    const report = this._recompute(changed);
    this.undoStack.push(txs);
    return this._result(report);
  }

  certificate() {
    return certificateOf({
      finalizeHorizon: Number.isFinite(this.finalizeHorizon) ? this.finalizeHorizon : null,
      observations: this.obs,
      nodes: [...this.nodes.values()].map((n) => ({ id: n.id, type: n.type, window: n.window, outputs: n.outputs })),
      log: this.log,
    });
  }

  snapshot() {
    return {
      finalizeHorizon: Number.isFinite(this.finalizeHorizon) ? this.finalizeHorizon : null,
      observations: this.obs.map((o) => ({ ...o })),
      nodes: [...this.nodes.values()].map((n) => ({ id: n.id, type: n.type, window: n.window, outputs: [...n.outputs] })),
      log: this.log.map((e) => ({ ...e })),
      certificate: this.certificate(),
    };
  }
}

module.exports = { Series, ERRORS, canonical, certificateOf };
