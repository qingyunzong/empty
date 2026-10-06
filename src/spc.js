'use strict';

const { normalizeRules } = require('./rules');

// Fenwick (binary indexed) tree over point positions. Three trees (count, sum,
// sum of squares) give sliding-window mean/sigma in O(log n) and support point
// updates (correct / invalidate) in O(log n).
class Fenwick {
  constructor(cap) {
    this.n = cap;
    this.t = new Float64Array(cap + 1);
  }
  add(i, v) {
    for (let x = i + 1; x <= this.n; x += x & -x) this.t[x] += v;
  }
  // prefix sum over positions [0, i]
  sum(i) {
    let s = 0;
    for (let x = i + 1; x > 0; x -= x & -x) s += this.t[x];
    return s;
  }
  range(l, r) {
    return this.sum(r) - (l > 0 ? this.sum(l - 1) : 0);
  }
  // 0-indexed position of the k-th stored element (k is 1-indexed, k >= 1)
  select(k) {
    let idx = 0;
    let bit = 1;
    while ((bit << 1) <= this.n) bit <<= 1;
    for (; bit; bit >>= 1) {
      const next = idx + bit;
      if (next <= this.n && this.t[next] < k) {
        idx = next;
        k -= this.t[next];
      }
    }
    return idx;
  }
}

class SPC {
  constructor(config = {}) {
    this.config = {
      windowSize: config.windowSize ?? 50,
      minSamples: config.minSamples ?? 10,
      unit: config.unit ?? null,
      conversions: config.conversions ?? {},
      rules: config.rules ?? ['WE1', 'WE2', 'WE3', 'WE4'],
    };
    this.rules = normalizeRules(this.config.rules);
    this.points = []; // arrival order
    this.byId = new Map();
    this.cap = 0;
    this._alarms = [];
    this._statuses = new Map();
    this._rebuild();
  }

  // ---- structures -------------------------------------------------------

  _rebuild() {
    this.cap = 16;
    while (this.cap < this.points.length + 1) this.cap *= 2;
    this.bitC = new Fenwick(this.cap);
    this.bitS = new Fenwick(this.cap);
    this.bitQ = new Fenwick(this.cap);
    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i];
      if (this._active(p)) this._fenwickAdd(i, p.value);
    }
  }

  _fenwickAdd(i, v) {
    this.bitC.add(i, 1);
    this.bitS.add(i, v);
    this.bitQ.add(i, v * v);
  }

  _fenwickRemove(i, v) {
    this.bitC.add(i, -1);
    this.bitS.add(i, -v);
    this.bitQ.add(i, -v * v);
  }

  _active(p) {
    return p.valid && !p.flags.includes('ERR_UNIT');
  }

  // ---- ingestion --------------------------------------------------------

  _normalize(raw) {
    if (raw == null || raw.id == null || typeof raw.value !== 'number' || !Number.isFinite(raw.value)) {
      throw new Error('point requires {id, finite numeric value}');
    }
    if (this.byId.has(raw.id)) throw new Error(`duplicate point id: ${raw.id}`);
    const p = {
      id: raw.id,
      ts: raw.ts ?? null,
      unit: raw.unit ?? this.config.unit,
      value: raw.value,
      valid: true,
      flags: [],
    };
    if (this.config.unit && p.unit !== this.config.unit) {
      const conv = this.config.conversions[p.unit];
      if (typeof conv === 'number') {
        p.value = raw.value * conv;
        p.flags.push('UNIT_CONVERTED');
      } else {
        // unknown unit: excluded from statistics, flagged, replayable
        p.flags.push('ERR_UNIT');
      }
    }
    return p;
  }

  insert(point) {
    const p = this._normalize(point);
    p.pos = this.points.length;
    this.points.push(p);
    this.byId.set(p.id, p);
    if (this.points.length > this.cap) this._rebuild();
    else if (this._active(p)) this._fenwickAdd(p.pos, p.value);
    // alarms depend only on the past, so appending only evaluates the new point
    this._evaluatePoint(p.pos);
    return {
      id: p.id,
      status: this._statuses.get(p.id),
      alarms: this._alarms.filter((a) => a.triggerId === p.id).map((a) => a.rule),
    };
  }

  correct(id, value) {
    const p = this.byId.get(id);
    if (!p) throw new Error(`unknown point id: ${id}`);
    if (!Number.isFinite(value)) throw new Error('corrected value must be finite');
    if (this._active(p)) this._fenwickRemove(p.pos, p.value);
    p.value = value;
    if (this._active(p)) this._fenwickAdd(p.pos, p.value);
    this._recomputeAll();
    return { id, status: this._statuses.get(id) };
  }

  invalidate(a, b) {
    const pa = this._posOf(a);
    const pb = b === undefined ? pa : this._posOf(b);
    const lo = Math.min(pa, pb);
    const hi = Math.max(pa, pb);
    let count = 0;
    for (let pos = lo; pos <= hi; pos++) {
      const p = this.points[pos];
      if (!p.valid) continue;
      if (this._active(p)) this._fenwickRemove(p.pos, p.value);
      p.valid = false;
      count++;
    }
    this._recomputeAll();
    return count;
  }

  _posOf(id) {
    const p = this.byId.get(id);
    if (!p) throw new Error(`unknown point id: ${id}`);
    return p.pos;
  }

  // ---- evaluation -------------------------------------------------------

  _recomputeAll() {
    this._alarms = [];
    this._statuses = new Map();
    for (let pos = 0; pos < this.points.length; pos++) this._evaluatePoint(pos);
  }

  // stats of active points in the sliding window of up to `windowSize`
  // active points immediately before position `pos` — O(log n)
  _windowStats(pos) {
    const c = this.bitC.sum(pos - 1);
    if (c === 0) return { n: 0, sum: 0, sq: 0, from: pos };
    const from = c > this.config.windowSize ? this.bitC.select(c - this.config.windowSize + 1) : 0;
    return {
      n: this.bitC.range(from, pos - 1),
      sum: this.bitS.range(from, pos - 1),
      sq: this.bitQ.range(from, pos - 1),
      from,
    };
  }

  _evaluatePoint(pos) {
    const p = this.points[pos];
    if (!this._active(p)) {
      this._statuses.set(p.id, 'EXCLUDED');
      return;
    }
    const stats = this._windowStats(pos);
    if (stats.n < this.config.minSamples) {
      this._statuses.set(p.id, 'UNKNOWN');
      return;
    }
    const mean = stats.sum / stats.n;
    let variance = stats.sq / stats.n - mean * mean;
    if (variance < 0) variance = 0; // constant stream / fp cancellation
    const sigma = Math.sqrt(variance);

    let maxBack = 1;
    for (const r of this.rules) maxBack = Math.max(maxBack, r.type === 'run' ? r.run : r.m);
    const c = this.bitC.sum(pos - 1); // active points before pos; current is (c+1)-th
    const trail = [];
    for (let j = Math.max(1, c + 1 - maxBack); j <= c; j++) trail.push(this.bitC.select(j));
    trail.push(pos);

    const fired = [];
    for (const rule of this.rules) {
      if (rule.type === 'beyond') {
        if (trail.length < rule.m) continue;
        const win = trail.slice(-rule.m);
        const hi = mean + rule.sigma * sigma;
        const lo = mean - rule.sigma * sigma;
        const above = win.filter((q) => this.points[q].value > hi);
        const below = win.filter((q) => this.points[q].value < lo);
        if (above.length >= rule.k) fired.push({ rule, side: 'above', involved: above });
        else if (below.length >= rule.k) fired.push({ rule, side: 'below', involved: below });
      } else {
        if (trail.length < rule.run) continue;
        const win = trail.slice(-rule.run);
        if (win.every((q) => this.points[q].value > mean)) fired.push({ rule, side: 'above', involved: win });
        else if (win.every((q) => this.points[q].value < mean)) fired.push({ rule, side: 'below', involved: win });
      }
    }

    this._statuses.set(p.id, fired.length ? 'ALARM' : 'IN_CONTROL');
    for (const f of fired) {
      const candidates = new Set(f.involved);
      candidates.add(pos); // trigger point is always part of the pattern
      this._alarms.push({
        rule: f.rule.name,
        triggerId: p.id,
        triggerPos: pos,
        side: f.side,
        candidates: [...candidates].sort((x, y) => x - y),
        limits: { mean, sigma, cl: mean, ucl: mean + 3 * sigma, lcl: mean - 3 * sigma, samples: stats.n },
        baselineFrom: stats.from,
      });
    }
  }

  // ---- queries ----------------------------------------------------------

  statusOf(id) {
    if (!this.byId.has(id)) throw new Error(`unknown point id: ${id}`);
    return this._statuses.get(id);
  }

  point(id) {
    const p = this.byId.get(id);
    if (!p) return undefined;
    return {
      id: p.id,
      value: p.value,
      unit: p.unit,
      valid: p.valid,
      flags: [...p.flags],
      status: this._statuses.get(p.id),
    };
  }

  get validCount() {
    return this.bitC.sum(this.points.length - 1);
  }

  status() {
    if (this.validCount < this.config.minSamples) return 'UNKNOWN';
    return this._alarms.length ? 'ALARM' : 'IN_CONTROL';
  }

  controlLimits() {
    const stats = this._windowStats(this.points.length);
    if (stats.n < this.config.minSamples) return { status: 'UNKNOWN', samples: stats.n, limits: null };
    const mean = stats.sum / stats.n;
    let variance = stats.sq / stats.n - mean * mean;
    if (variance < 0) variance = 0;
    const sigma = Math.sqrt(variance);
    return {
      status: 'OK',
      samples: stats.n,
      limits: { mean, sigma, cl: mean, ucl: mean + 3 * sigma, lcl: mean - 3 * sigma },
    };
  }

  alarms() {
    return this._alarms.map((a) => ({
      rule: a.rule,
      trigger: a.triggerId,
      side: a.side,
      subset: this._minimalSubset(a),
      limits: { ...a.limits },
      explanation: this._explain(a),
    }));
  }

  // Minimal triggering subset: the trigger point plus every candidate point
  // whose individual removal from the stream makes this alarm disappear.
  _minimalSubset(alarm) {
    const keep = [];
    for (const pos of alarm.candidates) {
      if (pos === alarm.triggerPos || !this._firesWithout(pos, alarm)) keep.push(pos);
    }
    return keep.map((pos) => this.points[pos].id);
  }

  _firesWithout(pos, alarm) {
    const p = this.points[pos];
    const wasActive = this._active(p);
    if (wasActive) this._fenwickRemove(pos, p.value);
    this._recomputeAll();
    const fires = this._alarms.some(
      (x) => x.rule === alarm.rule && x.triggerId === alarm.triggerId && x.side === alarm.side,
    );
    if (wasActive) this._fenwickAdd(pos, p.value);
    this._recomputeAll();
    return fires;
  }

  _explain(a) {
    const from = Math.min(a.baselineFrom, ...a.candidates);
    const to = a.triggerPos;
    const gapPoints = [];
    const unitPoints = [];
    for (let pos = from; pos <= to; pos++) {
      const p = this.points[pos];
      if (!p.valid) gapPoints.push(p.id);
      if (p.flags.includes('ERR_UNIT') || p.flags.includes('UNIT_CONVERTED')) unitPoints.push(p.id);
    }
    const notes = [];
    if (gapPoints.length) notes.push(`data gap(s) inside baseline/pattern span: ${gapPoints.join(', ')}`);
    if (unitPoints.length) notes.push(`unit problem(s) inside baseline/pattern span: ${unitPoints.join(', ')}`);
    if (!notes.length) notes.push('no data gap or unit conversion issue in baseline/pattern span');
    return { dataGap: gapPoints.length > 0, unitError: unitPoints.length > 0, gapPoints, unitPoints, notes };
  }

  // Raw snapshot for the independent brute-force reference.
  snapshot() {
    return {
      points: this.points.map((p) => ({
        id: p.id,
        ts: p.ts,
        value: p.value,
        unit: p.unit,
        valid: p.valid,
        flags: [...p.flags],
      })),
      config: { ...this.config },
    };
  }
}

module.exports = { SPC, Fenwick };
