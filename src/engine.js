export const ERR = Object.freeze({
  LIMIT: 'E_LIMIT',
  INTERVAL: 'E_INTERVAL',
  PERIOD: 'E_PERIOD',
  RACE: 'E_RACE',
});

export class EngineError extends Error {
  constructor(code, reason, detail = {}) {
    super(`${code}: ${reason}`);
    this.name = 'EngineError';
    this.code = code;
    this.reason = reason;
    this.detail = detail;
  }
}

const isInt = Number.isInteger;

export class LimitEngine {
  constructor(config) {
    const { totalLimit, dailyCaps = {}, periodMinutes, dayMinutes = 1440, anchor = 0 } = config;
    if (!isInt(totalLimit) || totalLimit <= 0) {
      throw new EngineError(ERR.LIMIT, 'totalLimit must be a positive integer', { totalLimit });
    }
    if (!isInt(periodMinutes) || periodMinutes <= 0) {
      throw new EngineError(ERR.PERIOD, 'periodMinutes must be a positive integer', { periodMinutes });
    }
    if (!isInt(dayMinutes) || dayMinutes <= 0) {
      throw new EngineError(ERR.PERIOD, 'dayMinutes must be a positive integer', { dayMinutes });
    }
    if (!isInt(anchor)) {
      throw new EngineError(ERR.PERIOD, 'anchor must be an integer', { anchor });
    }
    for (const [k, v] of Object.entries(dailyCaps)) {
      if (!isInt(v) || v <= 0) {
        throw new EngineError(ERR.LIMIT, 'daily cap must be a positive integer', { category: k, cap: v });
      }
    }
    this.totalLimit = totalLimit;
    this.dailyCaps = { ...dailyCaps };
    this.periodMinutes = periodMinutes;
    this.dayMinutes = dayMinutes;
    this.anchor = anchor;
    this.holds = [];
    this.captures = [];
    this.now = 0;
    this.version = 0;
    this.captureSeq = 0;
  }

  periodIndex(t) { return Math.floor((t - this.anchor) / this.periodMinutes); }
  periodStart(t) { return this.anchor + this.periodIndex(t) * this.periodMinutes; }
  periodEnd(t) { return this.periodStart(t) + this.periodMinutes; }
  dayIndex(t) { return Math.floor(t / this.dayMinutes); }

  checkVersion(op) {
    if (op.expectedVersion !== undefined && op.expectedVersion !== this.version) {
      throw new EngineError(ERR.RACE, 'stale expectedVersion', {
        expected: op.expectedVersion,
        actual: this.version,
      });
    }
  }

  occupancyAt(t) {
    let total = 0;
    const byCategory = {};
    const add = (cat, amt) => {
      total += amt;
      byCategory[cat] = (byCategory[cat] ?? 0) + amt;
    };
    for (const h of this.holds) {
      if (h.start <= t && t < h.end) add(h.category, h.amount);
    }
    const p = this.periodIndex(t);
    for (const c of this.captures) {
      if (c.at <= t && this.periodIndex(c.at) === p) add(c.category, c.amount);
    }
    return { total, byCategory };
  }

  dayUsage(category, d) {
    const ds = d * this.dayMinutes;
    const de = ds + this.dayMinutes;
    const perHold = new Map();
    for (const h of this.holds) {
      if (h.category === category && h.start < de && ds < h.end) {
        perHold.set(h.id, Math.max(perHold.get(h.id) ?? 0, h.amount));
      }
    }
    let used = 0;
    for (const v of perHold.values()) used += v;
    for (const c of this.captures) {
      if (c.category === category && this.dayIndex(c.at) === d) used += c.amount;
    }
    return used;
  }

  checkLimits(category, amount, start, end) {
    const points = new Set([start]);
    for (const h of this.holds) {
      if (h.start > start && h.start < end) points.add(h.start);
      if (h.end > start && h.end < end) points.add(h.end);
    }
    for (const c of this.captures) {
      if (c.at > start && c.at < end) points.add(c.at);
    }
    for (let k = this.periodIndex(start); k <= this.periodIndex(end - 1); k++) {
      const b = this.anchor + (k + 1) * this.periodMinutes;
      if (b > start && b < end) points.add(b);
    }
    for (const p of [...points].sort((a, b) => a - b)) {
      const occ = this.occupancyAt(p);
      if (occ.total + amount > this.totalLimit) {
        throw new EngineError(ERR.LIMIT, 'total limit exceeded', {
          kind: 'total', at: p, limit: this.totalLimit, current: occ.total, requested: amount,
        });
      }
    }
    const cap = this.dailyCaps[category];
    if (cap !== undefined) {
      for (let d = this.dayIndex(start); d <= this.dayIndex(end - 1); d++) {
        const used = this.dayUsage(category, d);
        if (used + amount > cap) {
          throw new EngineError(ERR.LIMIT, 'daily category limit exceeded', {
            kind: 'daily', category, day: d, limit: cap, current: used, requested: amount,
          });
        }
      }
    }
  }

  validateInvariant() {
    const points = new Set();
    for (const h of this.holds) { points.add(h.start); }
    for (const c of this.captures) { points.add(c.at); points.add(this.periodEnd(c.at)); }
    for (const p of points) {
      const occ = this.occupancyAt(p);
      if (occ.total > this.totalLimit) {
        throw new EngineError(ERR.LIMIT, 'total limit exceeded', {
          kind: 'total', at: p, limit: this.totalLimit, current: occ.total,
        });
      }
    }
    const days = new Set();
    for (const h of this.holds) {
      for (let d = this.dayIndex(h.start); d <= this.dayIndex(h.end - 1); d++) days.add(d);
    }
    for (const c of this.captures) days.add(this.dayIndex(c.at));
    for (const d of days) {
      for (const category of Object.keys(this.dailyCaps)) {
        const used = this.dayUsage(category, d);
        if (used > this.dailyCaps[category]) {
          throw new EngineError(ERR.LIMIT, 'daily category limit exceeded', {
            kind: 'daily', category, day: d, limit: this.dailyCaps[category], current: used,
          });
        }
      }
    }
  }

  freeze(op) {
    this.checkVersion(op);
    const { id, category, amount, start, end } = op;
    if (typeof id !== 'string' || id.length === 0) {
      throw new EngineError(ERR.INTERVAL, 'hold id required');
    }
    if (typeof category !== 'string' || category.length === 0) {
      throw new EngineError(ERR.INTERVAL, 'category required', { id });
    }
    if (!isInt(amount) || amount <= 0) {
      throw new EngineError(ERR.INTERVAL, 'amount must be a positive integer', { id, amount });
    }
    if (!isInt(start) || !isInt(end) || start >= end) {
      throw new EngineError(ERR.INTERVAL, 'require integer start < end', { id, start, end });
    }
    if (this.holds.some((h) => h.id === id)) {
      throw new EngineError(ERR.INTERVAL, 'duplicate hold id', { id });
    }
    if (start < this.periodStart(this.now)) {
      throw new EngineError(ERR.PERIOD, 'interval starts in a closed period', {
        id, start, periodStart: this.periodStart(this.now), now: this.now,
      });
    }
    this.checkLimits(category, amount, start, end);
    this.holds.push({ id, category, amount, start, end });
    this.version += 1;
    return this.state();
  }

  release(op, mode) {
    this.checkVersion(op);
    const { id } = op;
    const frags = this.holds.filter((h) => h.id === id);
    if (frags.length === 0) {
      throw new EngineError(ERR.INTERVAL, 'unknown hold', { id });
    }
    const start = op.start ?? Math.min(...frags.map((f) => f.start));
    const end = op.end ?? Math.max(...frags.map((f) => f.end));
    if (!isInt(start) || !isInt(end) || start >= end) {
      throw new EngineError(ERR.INTERVAL, 'require integer start < end', { id, start, end });
    }
    const amount = op.amount ?? null;
    if (amount !== null && (!isInt(amount) || amount <= 0)) {
      throw new EngineError(ERR.INTERVAL, 'amount must be a positive integer', { id, amount });
    }
    const overlapping = frags.filter((f) => f.start < end && start < f.end);
    if (overlapping.length === 0) {
      throw new EngineError(ERR.INTERVAL, 'interval does not overlap hold', { id, start, end });
    }
    if (amount !== null) {
      for (const f of overlapping) {
        if (amount > f.amount) {
          throw new EngineError(ERR.INTERVAL, 'amount exceeds held amount on a fragment', {
            id, amount, fragmentAmount: f.amount,
          });
        }
      }
    }
    let at = null;
    if (mode === 'capture') {
      at = op.at ?? this.now;
      if (!isInt(at) || at < 0) {
        throw new EngineError(ERR.INTERVAL, 'capture time must be a non-negative integer', { id, at });
      }
    }
    const snapshot = { holds: this.holds, captures: this.captures, captureSeq: this.captureSeq };
    const next = [];
    let moved = 0;
    const category = frags[0].category;
    for (const h of this.holds) {
      if (h.id !== id || h.start >= end || start >= h.end) {
        next.push(h);
        continue;
      }
      const lo = Math.max(h.start, start);
      const hi = Math.min(h.end, end);
      if (h.start < lo) next.push({ ...h, end: lo });
      const cut = amount ?? h.amount;
      const remain = h.amount - cut;
      if (remain > 0) next.push({ ...h, start: lo, end: hi, amount: remain });
      if (hi < h.end) next.push({ ...h, start: hi });
      moved += cut;
    }
    this.holds = next;
    if (mode === 'capture' && moved > 0) {
      this.captureSeq += 1;
      this.captures.push({ id: `cap${this.captureSeq}`, holdId: id, category, amount: moved, at });
    }
    try {
      this.validateInvariant();
    } catch (e) {
      this.holds = snapshot.holds;
      this.captures = snapshot.captures;
      this.captureSeq = snapshot.captureSeq;
      throw e;
    }
    this.version += 1;
    return this.state();
  }

  unfreeze(op) { return this.release(op, 'unfreeze'); }
  capture(op) { return this.release(op, 'capture'); }

  sweep(op) {
    const { at } = op;
    if (!isInt(at) || at < 0) {
      throw new EngineError(ERR.INTERVAL, 'at must be a non-negative integer', { at });
    }
    if (at < this.now) {
      throw new EngineError(ERR.INTERVAL, 'cannot move clock backward', { at, now: this.now });
    }
    this.now = at;
    const released = [];
    const expiredCaptures = [];
    const p = this.periodIndex(at);
    this.holds = this.holds.filter((h) => {
      if (h.end <= at) { released.push(h.id); return false; }
      return true;
    });
    this.captures = this.captures.filter((c) => {
      if (this.periodIndex(c.at) < p) { expiredCaptures.push(c.id); return false; }
      return true;
    });
    if (released.length > 0 || expiredCaptures.length > 0) this.version += 1;
    return { released: [...new Set(released)], expiredCaptures, state: this.state() };
  }

  dispatch(op) {
    const kind = op.op;
    switch (kind) {
      case 'freeze': return this.freeze(op);
      case 'unfreeze': return this.unfreeze(op);
      case 'capture': return this.capture(op);
      case 'sweep': return this.sweep(op);
      case 'batch': return { results: this.applyBatch(op.ops) };
      default: throw new EngineError(ERR.INTERVAL, 'unknown op', { op: kind });
    }
  }

  apply(op) {
    try {
      const out = this.dispatch(op);
      const state = op.op === 'batch' || op.op === 'sweep' ? this.state() : out;
      const result = { ok: true, op: opLabel(op) };
      if (op.op === 'sweep') {
        result.released = out.released;
        result.expiredCaptures = out.expiredCaptures;
      }
      if (op.op === 'batch') result.results = out.results;
      result.state = state;
      return result;
    } catch (e) {
      if (e instanceof EngineError) {
        return { ok: false, op: opLabel(op), code: e.code, reason: e.reason, detail: e.detail };
      }
      throw e;
    }
  }

  applyBatch(ops) {
    const indexed = ops.map((op, i) => ({ op, i }));
    indexed.sort((a, b) =>
      (b.op.priority ?? 0) - (a.op.priority ?? 0)
      || (a.op.seq ?? a.i) - (b.op.seq ?? b.i)
      || a.i - b.i);
    return indexed.map(({ op, i }) => {
      const r = this.apply(op);
      r.submitOrder = i;
      return r;
    });
  }

  state() {
    const points = new Set();
    for (const h of this.holds) { points.add(h.start); points.add(h.end); }
    for (const c of this.captures) { points.add(c.at); points.add(this.periodEnd(c.at)); }
    const sorted = [...points].sort((a, b) => a - b);
    const raw = [];
    for (let i = 0; i + 1 < sorted.length; i++) {
      const s = sorted[i];
      const e = sorted[i + 1];
      const holds = this.holds
        .filter((h) => h.start <= s && s < h.end)
        .map((h) => ({ id: h.id, category: h.category, amount: h.amount }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const p = this.periodIndex(s);
      const captures = this.captures
        .filter((c) => c.at <= s && this.periodIndex(c.at) === p)
        .map((c) => ({ id: c.id, category: c.category, amount: c.amount }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (holds.length === 0 && captures.length === 0) continue;
      let total = 0;
      const byCategory = {};
      for (const x of [...holds, ...captures]) {
        total += x.amount;
        byCategory[x.category] = (byCategory[x.category] ?? 0) + x.amount;
      }
      raw.push({ start: s, end: e, total, byCategory, holds, captures });
    }
    const segments = [];
    for (const seg of raw) {
      const key = segmentKey(seg);
      const last = segments[segments.length - 1];
      if (last && last.end === seg.start && last.key === key) {
        last.end = seg.end;
      } else {
        segments.push({ ...seg, key });
      }
    }
    const coalesced = [];
    const merges = [];
    for (const seg of segments) {
      const amountKey = JSON.stringify({ total: seg.total, byCategory: seg.byCategory });
      const last = coalesced[coalesced.length - 1];
      if (last && last.end === seg.start && last.amountKey === amountKey) {
        merges.push({
          from: [[last.start, last.end], [seg.start, seg.end]],
          into: [last.start, seg.end],
          total: seg.total,
          byCategory: seg.byCategory,
        });
        last.end = seg.end;
      } else {
        coalesced.push({
          start: seg.start,
          end: seg.end,
          total: seg.total,
          byCategory: seg.byCategory,
          amountKey,
        });
      }
    }
    return {
      version: this.version,
      now: this.now,
      segments: segments.map(({ key, ...rest }) => rest),
      coalesced: coalesced.map(({ amountKey, ...rest }) => rest),
      merges,
    };
  }
}

function segmentKey(seg) {
  const h = seg.holds.map((x) => `${x.id}:${x.category}:${x.amount}`).join(',');
  const c = seg.captures.map((x) => `${x.id}:${x.category}:${x.amount}`).join(',');
  return `h[${h}]c[${c}]`;
}

function opLabel(op) {
  const id = op.id ? ` ${op.id}` : '';
  return `${op.op}${id}`;
}
