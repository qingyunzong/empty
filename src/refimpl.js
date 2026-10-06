// Brute-force reference implementation used only for cross-checking.
// Deliberately written independently from LimitEngine: minute-by-minute
// enumeration, no shared interval logic.
export class RefEngine {
  constructor(config = {}) {
    this.totalCap = config.totalCap;
    this.categoryCaps = { ...(config.categoryCaps ?? {}) };
    this.origin = config.period?.origin ?? 0;
    this.length = config.period.length;
    this.count = config.period.count;
    this.domainStart = this.origin;
    this.domainEnd = this.origin + this.length * this.count;
    this.now = this.domainStart;
    this.groups = new Map(); // id -> { category, amount, intervals: [[s,e)], status }
  }

  occupancyAt(t) {
    let occ = 0;
    for (const g of this.groups.values()) {
      if (g.status !== 'active') continue;
      for (const [s, e] of g.intervals) {
        if (s <= t && t < e) {
          occ += g.amount;
          break;
        }
      }
    }
    return occ;
  }

  catUsage(category, p) {
    const ps = this.origin + p * this.length;
    const pe = ps + this.length;
    let usage = 0;
    for (const g of this.groups.values()) {
      if (g.status !== 'active' || g.category !== category) continue;
      for (const [s, e] of g.intervals) {
        if (s < pe && ps < e) {
          usage += g.amount;
          break;
        }
      }
    }
    return usage;
  }

  #group(id) {
    const g = this.groups.get(id);
    if (!g || g.status !== 'active') return null;
    return g;
  }

  freeze(req) {
    const { start: s, end: e } = req;
    let g;
    if (req.group !== undefined) {
      g = this.#group(req.group);
      if (!g) return { ok: false, code: 'E_INTERVAL' };
    } else {
      if (!Number.isInteger(req.amount) || req.amount <= 0) return { ok: false, code: 'E_LIMIT' };
      if (typeof req.category !== 'string' || !req.category) return { ok: false, code: 'E_LIMIT' };
      if (req.id !== undefined && this.groups.has(req.id)) return { ok: false, code: 'E_RACE' };
    }
    const amount = g ? g.amount : req.amount;
    const category = g ? g.category : req.category;
    if (!Number.isInteger(s) || !Number.isInteger(e) || s >= e) return { ok: false, code: 'E_INTERVAL' };
    if (s < this.domainStart || e > this.domainEnd) return { ok: false, code: 'E_PERIOD' };
    if (s < this.now) return { ok: false, code: 'E_PERIOD' };
    if (g) {
      for (const [fs, fe] of g.intervals) {
        if (fs < e && s < fe) return { ok: false, code: 'E_INTERVAL' };
      }
    }
    for (let t = s; t < e; t++) {
      if (this.occupancyAt(t) + amount > this.totalCap) return { ok: false, code: 'E_LIMIT' };
    }
    const cap = this.categoryCaps[category];
    if (cap !== undefined) {
      const p0 = Math.floor((s - this.origin) / this.length);
      const p1 = Math.floor((e - 1 - this.origin) / this.length);
      for (let p = p0; p <= p1; p++) {
        if (this.catUsage(category, p) + amount > cap) return { ok: false, code: 'E_LIMIT' };
      }
    }
    if (!g) {
      g = { category, amount, intervals: [], status: 'active' };
      this.groups.set(req.id ?? `G${this.groups.size + 1}`, g);
    }
    g.intervals.push([s, e]);
    return { ok: true };
  }

  unfreeze(req) {
    const g = this.#group(req.group);
    if (!g) return { ok: false, code: 'E_INTERVAL' };
    const { start: s, end: e } = req;
    if (!Number.isInteger(s) || !Number.isInteger(e) || s >= e) return { ok: false, code: 'E_INTERVAL' };
    if (s < this.domainStart || e > this.domainEnd) return { ok: false, code: 'E_PERIOD' };
    let touched = false;
    const next = [];
    for (const [fs, fe] of g.intervals) {
      if (fe <= s || fs >= e) {
        next.push([fs, fe]);
        continue;
      }
      touched = true;
      if (fs < s) next.push([fs, s]);
      if (fe > e) next.push([e, fe]);
    }
    if (!touched) return { ok: false, code: 'E_INTERVAL' };
    g.intervals = next;
    if (next.length === 0) g.status = 'released';
    return { ok: true };
  }

  capture(req) {
    const g = this.#group(req.group);
    if (!g) return { ok: false, code: 'E_INTERVAL' };
    const { amount } = req;
    if (!Number.isInteger(amount) || amount <= 0) return { ok: false, code: 'E_LIMIT' };
    if (amount > g.amount) return { ok: false, code: 'E_LIMIT' };
    g.amount -= amount;
    if (g.amount === 0) {
      g.status = 'captured';
      g.intervals = [];
    }
    return { ok: true };
  }

  advance(req) {
    const { now } = req;
    if (!Number.isInteger(now) || now < this.now) return { ok: false, code: 'E_PERIOD' };
    if (now > this.domainEnd) return { ok: false, code: 'E_PERIOD' };
    this.now = now;
    for (const g of this.groups.values()) {
      if (g.status !== 'active') continue;
      g.intervals = g.intervals
        .filter(([, e]) => e > now)
        .map(([s, e]) => [Math.max(s, now), e]);
      if (g.intervals.length === 0) g.status = 'expired';
    }
    return { ok: true };
  }

  apply(req) {
    switch (req.op) {
      case 'freeze':
        return this.freeze(req);
      case 'unfreeze':
        return this.unfreeze(req);
      case 'capture':
        return this.capture(req);
      case 'advance':
        return this.advance(req);
      default:
        return { ok: false, code: 'E_INTERVAL' };
    }
  }
}
