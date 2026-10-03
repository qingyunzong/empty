// spc.js — incremental SPC engine.
//
// Points are kept ordered by sequence number. Three Fenwick trees over the
// ordered entries (valid-count, sum, sum-of-squares) give O(log n) updates
// for correct()/invalidate() and O(log n) window statistics. Structural
// inserts (including out-of-order ones) rebuild the trees in O(n); only
// correct()/invalidate() are on the hot O(log n) path, as required.
//
// Every mutating operation is appended to `engine.log`; replayLog()
// reconstructs a byte-identical state from it (see src/faults.js).

import { normalizeRules, checkRuleOnSubset, sideOf, isBeyond } from './naive.js';

class Fenwick {
  constructor(size) {
    this.n = size;
    this.t = new Float64Array(size + 1);
  }
  add(i, delta) {
    for (let x = i + 1; x <= this.n; x += x & -x) this.t[x] += delta;
  }
  prefix(i) {
    // sum of elements [0, i)
    let s = 0;
    for (let x = i; x > 0; x -= x & -x) s += this.t[x];
    return s;
  }
  range(l, r) {
    // inclusive [l, r]
    return this.prefix(r + 1) - this.prefix(l);
  }
  total() {
    return this.prefix(this.n);
  }
  // 0-based index of the k-th (1-based) accumulated element; requires k <= total().
  findByOrder(k) {
    let i = 0;
    let bit = 1 << (31 - Math.clz32(this.n || 1));
    while (bit) {
      const next = i + bit;
      if (next <= this.n && this.t[next] < k) {
        k -= this.t[next];
        i = next;
      }
      bit >>= 1;
    }
    return i;
  }
}

export class SPCEngine {
  constructor(options = {}) {
    this.windowSize = options.windowSize ?? Infinity;
    this.minSamples = options.minSamples ?? 5;
    this.rules = normalizeRules(options.rules);
    this.unit = {
      expected: options.unit?.expected ?? null,
      autoDetect: options.unit?.autoDetect ?? false,
      factor: options.unit?.factor ?? 5,
    };
    this.entries = []; // {id, seq, tie, value, valid, flags} ordered by (seq, tie)
    this.byId = new Map();
    this.lastSeq = 0;
    this.tie = 0;
    this.log = [];
    this._rebuildTrees();
    this.state = this._evaluate();
  }

  _rebuildTrees() {
    const n = this.entries.length;
    this.countTree = new Fenwick(n);
    this.sumTree = new Fenwick(n);
    this.sqTree = new Fenwick(n);
    this.entries.forEach((e, i) => {
      e._index = i;
      if (e.valid) {
        this.countTree.add(i, 1);
        this.sumTree.add(i, e.value);
        this.sqTree.add(i, e.value * e.value);
      }
    });
  }

  _record(entry) {
    this.log.push(structuredClone(entry));
  }

  _checkUnit(point) {
    const flags = [];
    if (this.unit.expected && point.unit && point.unit !== this.unit.expected) {
      flags.push('ERR_UNIT');
    } else if (this.unit.autoDetect) {
      const values = this.entries.filter((e) => e.valid).map((e) => e.value);
      if (values.length >= this.minSamples) {
        const sorted = [...values].sort((a, b) => a - b);
        const mid = sorted.length >> 1;
        const median =
          sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
        if (median !== 0) {
          const ratio = Math.abs(point.value / median);
          if (ratio > this.unit.factor || ratio < 1 / this.unit.factor) {
            flags.push('ERR_UNIT');
          }
        }
      }
    }
    return flags;
  }

  // point: {id, value, seq?, unit?}. Returns {id, seq, flags}.
  insert(point) {
    if (this.byId.has(point.id)) throw new Error(`duplicate point id: ${point.id}`);
    let seq;
    if (point.seq === undefined) {
      seq = this.lastSeq + 1;
    } else {
      seq = point.seq;
    }
    this.lastSeq = Math.max(this.lastSeq, seq);
    const flags = this._checkUnit(point);
    const entry = {
      id: point.id,
      seq,
      tie: this.tie++,
      value: point.value,
      valid: flags.length === 0,
      flags,
    };
    // binary search insertion position on (seq, tie)
    let lo = 0;
    let hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const m = this.entries[mid];
      if (m.seq < seq || (m.seq === seq && m.tie < entry.tie)) lo = mid + 1;
      else hi = mid;
    }
    this.entries.splice(lo, 0, entry);
    this.byId.set(entry.id, entry);
    this._rebuildTrees(); // structural change: O(n); updates stay O(log n)
    this._record({ op: 'insert', point: { ...point, seq } });
    this.state = this._evaluate();
    return { id: entry.id, seq, flags: [...flags] };
  }

  // Correct the value of a historical point. O(log n) tree updates.
  correct(id, value) {
    const entry = this.byId.get(id);
    if (!entry) return false;
    if (entry.valid) {
      const i = entry._index;
      this.sumTree.add(i, value - entry.value);
      this.sqTree.add(i, value * value - entry.value * entry.value);
    }
    entry.value = value;
    this._record({ op: 'correct', id, value });
    this.state = this._evaluate();
    return true;
  }

  // Invalidate every point whose seq lies in [fromSeq, toSeq]. O(k log n).
  invalidate(fromSeq, toSeq) {
    let count = 0;
    for (const e of this.entries) {
      if (e.seq < fromSeq || e.seq > toSeq || !e.valid) continue;
      e.valid = false;
      const i = e._index;
      this.countTree.add(i, -1);
      this.sumTree.add(i, -e.value);
      this.sqTree.add(i, -e.value * e.value);
      count++;
    }
    this._record({ op: 'invalidate', from: fromSeq, to: toSeq });
    this.state = this._evaluate();
    return count;
  }

  _evaluate() {
    const totalValid = this.countTree.total();
    const flaggedPoints = this.entries
      .filter((e) => e.flags.length > 0)
      .map((e) => ({ id: e.id, seq: e.seq, flags: [...e.flags] }));

    if (totalValid < this.minSamples) {
      return {
        status: 'UNKNOWN',
        alarms: [],
        controlLimits: null,
        validCount: totalValid,
        flaggedPoints,
      };
    }

    const n = this.entries.length;
    const width = Math.min(this.windowSize, totalValid);
    // first index of the window: position of the (totalValid - width + 1)-th valid point
    const lo =
      totalValid > width ? this.countTree.findByOrder(totalValid - width + 1) : 0;
    const sum = this.sumTree.range(lo, n - 1);
    const sq = this.sqTree.range(lo, n - 1);
    const mu = sum / width;
    let variance = sq / width - mu * mu;
    if (variance < 0) variance = 0;
    const sigma = Math.sqrt(variance);

    const pts = [];
    for (let i = lo; i < n; i++) {
      const e = this.entries[i];
      if (e.valid) pts.push({ id: e.id, value: e.value });
    }

    const alarms = this._detectAlarms(pts, mu, sigma);
    for (const alarm of alarms) {
      alarm.minimalSubset = this._minimize(alarm, pts, mu, sigma);
    }

    return {
      status: alarms.length > 0 ? 'ALARM' : 'OK',
      alarms,
      controlLimits: {
        center: mu,
        sigma,
        ucl: mu + 3 * sigma,
        lcl: mu - 3 * sigma,
        n: width,
      },
      validCount: totalValid,
      flaggedPoints,
    };
  }

  _detectAlarms(pts, mu, sigma) {
    const rules = this.rules;
    const alarms = [];
    const seen = new Set();
    const push = (alarm) => {
      const key = `${alarm.rule}|${alarm.side}|${alarm.pointIds.join(',')}`;
      if (seen.has(key)) return;
      seen.add(key);
      alarm.id = `${alarm.rule}#${alarm.pointIds[0]}`;
      alarms.push(alarm);
    };

    if (rules.beyondSigma.enabled) {
      for (const p of pts) {
        if (isBeyond(p.value, mu, sigma, rules.beyondSigma.k)) {
          push({ rule: 'beyondSigma', side: sideOf(p.value, mu), pointIds: [p.id] });
        }
      }
    }

    for (const name of ['twoOfThree', 'fourOfFive']) {
      const cfg = rules[name];
      if (!cfg.enabled) continue;
      for (let i = 0; i + cfg.of <= pts.length; i++) {
        const slice = pts.slice(i, i + cfg.of);
        for (const s of [1, -1]) {
          let hit = 0;
          for (const p of slice) {
            if (sideOf(p.value, mu) === s && isBeyond(p.value, mu, sigma, cfg.k)) hit++;
          }
          if (hit >= cfg.n) {
            push({ rule: name, side: s, pointIds: slice.map((p) => p.id) });
            break;
          }
        }
      }
    }

    if (rules.runSide.enabled) {
      let i = 0;
      while (i < pts.length) {
        const s = sideOf(pts[i].value, mu);
        if (s === 0) {
          i++;
          continue;
        }
        let j = i;
        while (j < pts.length && sideOf(pts[j].value, mu) === s) j++;
        if (j - i >= rules.runSide.run) {
          push({ rule: 'runSide', side: s, pointIds: pts.slice(i, j).map((p) => p.id) });
        }
        i = j;
      }
    }
    return alarms;
  }

  // Greedy 1-minimization of the alarm's witness subset, checked against the
  // FIXED (mu, sigma) of the current window: removing any single remaining
  // point makes the alarm disappear.
  _minimize(alarm, pts, mu, sigma) {
    const cfg = this.rules[alarm.rule];
    const valueOf = new Map(pts.map((p) => [p.id, p.value]));
    let subset = [...alarm.pointIds];
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of [...subset]) {
        if (subset.length <= 1) break;
        const candidate = subset.filter((x) => x !== id);
        const values = candidate.map((x) => valueOf.get(x));
        if (checkRuleOnSubset(alarm.rule, cfg, values, mu, sigma)) {
          subset = candidate;
          changed = true;
        }
      }
    }
    return subset;
  }

  getState() {
    return structuredClone(this.state);
  }
}
