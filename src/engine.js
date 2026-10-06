import { normalizeOccupancy } from './intervals.js';

export class EngineError extends Error {
  constructor(code, reason, details = {}) {
    super(reason);
    this.name = 'EngineError';
    this.code = code;
    this.details = details;
  }
}

const isInt = (v) => Number.isInteger(v);

// A freeze group owns one logical freeze (id, category, uniform amount).
// Partial unfreezes split it into disjoint half-open interval fragments;
// re-freezing the gap with the same group id merges fragments back.
export class LimitEngine {
  constructor(config = {}) {
    const { totalCap, categoryCaps = {}, period = {} } = config;
    if (!isInt(totalCap) || totalCap <= 0) {
      throw new EngineError('E_LIMIT', 'totalCap must be a positive integer', { totalCap });
    }
    const { origin = 0, length, count } = period;
    if (!isInt(origin) || !isInt(length) || length <= 0 || !isInt(count) || count <= 0) {
      throw new EngineError(
        'E_PERIOD',
        'period requires integer origin and positive integer length/count',
        { period },
      );
    }
    for (const [cat, cap] of Object.entries(categoryCaps)) {
      if (!isInt(cap) || cap <= 0) {
        throw new EngineError('E_LIMIT', `category cap for '${cat}' must be a positive integer`, {
          category: cat,
          cap,
        });
      }
    }
    this.totalCap = totalCap;
    this.categoryCaps = { ...categoryCaps };
    this.period = { origin, length, count };
    this.domainStart = origin;
    this.domainEnd = origin + length * count;
    this.now = this.domainStart;
    this.version = 0;
    this.seqCounter = 0;
    this.groupCounter = 0;
    this.fragCounter = 0;
    this.groups = new Map();
    this.ledger = [];
  }

  periodIndex(t) {
    return Math.floor((t - this.period.origin) / this.period.length);
  }

  periodBounds(p) {
    return [this.period.origin + p * this.period.length, this.period.origin + (p + 1) * this.period.length];
  }

  activeFragments() {
    const frags = [];
    for (const g of this.groups.values()) {
      if (g.status !== 'active') continue;
      for (const f of g.fragments.values()) {
        frags.push({ id: f.id, group: g.id, start: f.start, end: f.end, amount: g.amount });
      }
    }
    return frags;
  }

  normalized() {
    return normalizeOccupancy(this.activeFragments());
  }

  occupancyAt(t) {
    let occ = 0;
    for (const g of this.groups.values()) {
      if (g.status !== 'active') continue;
      for (const f of g.fragments.values()) {
        if (f.start <= t && t < f.end) {
          occ += g.amount;
          break;
        }
      }
    }
    return occ;
  }

  categoryPeriodUsage(category, p) {
    const [ps, pe] = this.periodBounds(p);
    let usage = 0;
    for (const g of this.groups.values()) {
      if (g.status !== 'active' || g.category !== category) continue;
      for (const f of g.fragments.values()) {
        if (f.start < pe && ps < f.end) {
          usage += g.amount; // cross-period carryover: counted in every period it touches
          break;
        }
      }
    }
    return usage;
  }

  periodUsage() {
    const cats = new Set([...Object.keys(this.categoryCaps)]);
    for (const g of this.groups.values()) if (g.status === 'active') cats.add(g.category);
    const rows = [];
    for (let p = 0; p < this.period.count; p++) {
      const [start, end] = this.periodBounds(p);
      for (const cat of [...cats].sort()) {
        const usage = this.categoryPeriodUsage(cat, p);
        if (usage > 0) rows.push({ period: p, start, end, category: cat, usage });
      }
    }
    return rows;
  }

  fragmentsOf(groupId) {
    const g = this.groups.get(groupId);
    if (!g) return [];
    return [...g.fragments.values()]
      .map((f) => ({ id: f.id, start: f.start, end: f.end }))
      .sort((a, b) => a.start - b.start);
  }

  status() {
    return {
      now: this.now,
      version: this.version,
      normalized: this.normalized(),
      periodUsage: this.periodUsage(),
      groups: [...this.groups.values()].map((g) => ({
        id: g.id,
        category: g.category,
        amount: g.amount,
        status: g.status,
        fragments: this.fragmentsOf(g.id),
      })),
    };
  }

  // Deterministic arbitration: priority desc, then submission seq asc.
  // Each request is atomic: it fully applies or is rejected without partial effect.
  submit(requests) {
    if (!Array.isArray(requests)) requests = [requests];
    const stamped = requests.map((r, i) => ({
      r,
      index: i,
      seq: this.seqCounter++,
      priority: r.priority ?? 0,
    }));
    const order = [...stamped].sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    const applied = [];
    for (const item of order) {
      const res = this.applyOne(item.r);
      applied.push({ index: item.index, seq: item.seq, priority: item.priority, ...res });
    }
    return applied; // in application (arbitration) order
  }

  submitOne(req) {
    return this.submit([req])[0];
  }

  applyOne(req) {
    try {
      if (req.expectedVersion !== undefined && req.expectedVersion !== this.version) {
        throw new EngineError(
          'E_RACE',
          `stale expectedVersion ${req.expectedVersion}, current version is ${this.version}`,
          { expected: req.expectedVersion, current: this.version },
        );
      }
      switch (req.op) {
        case 'freeze':
          return { ok: true, ...this.#freeze(req) };
        case 'unfreeze':
          return { ok: true, ...this.#unfreeze(req) };
        case 'capture':
          return { ok: true, ...this.#capture(req) };
        case 'advance':
          return { ok: true, ...this.#advance(req) };
        default:
          throw new EngineError('E_INTERVAL', `unknown op '${req.op}'`, { op: req.op });
      }
    } catch (err) {
      if (err instanceof EngineError) {
        return {
          ok: false,
          op: req.op,
          id: req.id ?? req.group,
          code: err.code,
          reason: err.message,
          details: err.details,
        };
      }
      throw err;
    }
  }

  #requireGroup(id) {
    const g = this.groups.get(id);
    if (!g || g.status !== 'active') {
      throw new EngineError('E_INTERVAL', `unknown or inactive group '${id}'`, { group: id });
    }
    return g;
  }

  #checkInterval(start, end, { enforceNow = true } = {}) {
    if (!isInt(start) || !isInt(end) || start >= end) {
      throw new EngineError('E_INTERVAL', `invalid half-open interval [${start}, ${end})`, {
        start,
        end,
      });
    }
    if (start < this.domainStart || end > this.domainEnd) {
      throw new EngineError(
        'E_PERIOD',
        `interval [${start}, ${end}) outside schedule [${this.domainStart}, ${this.domainEnd})`,
        { start, end, domainStart: this.domainStart, domainEnd: this.domainEnd },
      );
    }
    if (enforceNow && start < this.now) {
      throw new EngineError('E_PERIOD', `interval [${start}, ${end}) starts in the past at now=${this.now}`, {
        start,
        end,
        now: this.now,
      });
    }
  }

  #checkLimits(category, amount, start, end) {
    for (const seg of this.normalized()) {
      if (seg.start < end && start < seg.end && seg.occupancy + amount > this.totalCap) {
        throw new EngineError(
          'E_LIMIT',
          `total cap exceeded at [${seg.start}, ${seg.end}): need ${amount}, available ${this.totalCap - seg.occupancy}`,
          { start: seg.start, end: seg.end, need: amount, available: this.totalCap - seg.occupancy },
        );
      }
    }
    const cap = this.categoryCaps[category];
    if (cap !== undefined) {
      const p0 = this.periodIndex(start);
      const p1 = this.periodIndex(end - 1);
      for (let p = p0; p <= p1; p++) {
        const usage = this.categoryPeriodUsage(category, p);
        if (usage + amount > cap) {
          throw new EngineError(
            'E_LIMIT',
            `category '${category}' cap exceeded in period ${p}: need ${amount}, available ${cap - usage}`,
            { category, period: p, need: amount, available: cap - usage },
          );
        }
      }
    }
  }

  #mergeGroup(group) {
    const merges = [];
    const sorted = [...group.fragments.values()].sort((a, b) => a.start - b.start);
    for (let i = 0; i + 1 < sorted.length; ) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (a.end === b.start) {
        const merged = { id: a.id, start: a.start, end: b.end };
        group.fragments.delete(a.id);
        group.fragments.delete(b.id);
        group.fragments.set(merged.id, merged);
        merges.push({ group: group.id, merged: [a.id, b.id], into: a.id, interval: [a.start, b.end] });
        sorted.splice(i, 2, merged);
        if (i > 0) i--;
      } else {
        i++;
      }
    }
    return merges;
  }

  #freeze(req) {
    const { start, end } = req;
    let group;
    if (req.group !== undefined) {
      group = this.#requireGroup(req.group);
    } else {
      if (!isInt(req.amount) || req.amount <= 0) {
        throw new EngineError('E_LIMIT', 'freeze amount must be a positive integer', {
          amount: req.amount,
        });
      }
      if (typeof req.category !== 'string' || req.category.length === 0) {
        throw new EngineError('E_LIMIT', 'freeze requires a non-empty category', {});
      }
      if (req.id !== undefined && this.groups.has(req.id)) {
        throw new EngineError('E_RACE', `duplicate freeze id '${req.id}'`, { id: req.id });
      }
    }
    const amount = group ? group.amount : req.amount;
    const category = group ? group.category : req.category;
    this.#checkInterval(start, end);
    if (group) {
      for (const f of group.fragments.values()) {
        if (f.start < end && start < f.end) {
          throw new EngineError(
            'E_INTERVAL',
            `interval [${start}, ${end}) overlaps existing fragment [${f.start}, ${f.end}) of group '${group.id}'`,
            { group: group.id, start, end },
          );
        }
      }
    }
    this.#checkLimits(category, amount, start, end);
    if (!group) {
      const id = req.id ?? `G${++this.groupCounter}`;
      group = {
        id,
        category,
        amount,
        priority: req.priority ?? 0,
        status: 'active',
        fragments: new Map(),
      };
      this.groups.set(id, group);
    }
    const fragId = `${group.id}#${++this.fragCounter}`;
    group.fragments.set(fragId, { id: fragId, start, end });
    const merges = this.#mergeGroup(group);
    this.version++;
    this.ledger.push({ version: this.version, op: 'freeze', group: group.id, start, end, amount, category });
    return {
      op: 'freeze',
      group: group.id,
      fragment: fragId,
      amount,
      category,
      interval: [start, end],
      version: this.version,
      merges,
      normalized: this.normalized(),
    };
  }

  #unfreeze(req) {
    const group = this.#requireGroup(req.group);
    const { start, end } = req;
    this.#checkInterval(start, end, { enforceNow: false });
    const next = new Map();
    const released = [];
    let touched = false;
    for (const f of group.fragments.values()) {
      if (f.end <= start || f.start >= end) {
        next.set(f.id, f);
        continue;
      }
      touched = true;
      released.push([Math.max(f.start, start), Math.min(f.end, end)]);
      if (f.start < start) {
        const id = `${group.id}#${++this.fragCounter}`;
        next.set(id, { id, start: f.start, end: start });
      }
      if (f.end > end) {
        const id = `${group.id}#${++this.fragCounter}`;
        next.set(id, { id, start: end, end: f.end });
      }
    }
    if (!touched) {
      throw new EngineError('E_INTERVAL', `interval [${start}, ${end}) does not intersect group '${group.id}'`, {
        group: group.id,
        start,
        end,
      });
    }
    group.fragments = next;
    if (next.size === 0) group.status = 'released';
    this.version++;
    this.ledger.push({ version: this.version, op: 'unfreeze', group: group.id, start, end });
    return {
      op: 'unfreeze',
      group: group.id,
      released,
      fragments: this.fragmentsOf(group.id),
      status: group.status,
      version: this.version,
      normalized: this.normalized(),
    };
  }

  #capture(req) {
    const group = this.#requireGroup(req.group);
    const { amount } = req;
    if (!isInt(amount) || amount <= 0) {
      throw new EngineError('E_LIMIT', 'capture amount must be a positive integer', { amount });
    }
    if (amount > group.amount) {
      throw new EngineError('E_LIMIT', `capture amount ${amount} exceeds frozen amount ${group.amount}`, {
        group: group.id,
        amount,
        frozen: group.amount,
      });
    }
    group.amount -= amount;
    if (group.amount === 0) {
      group.status = 'captured';
      group.fragments.clear();
    }
    this.version++;
    this.ledger.push({ version: this.version, op: 'capture', group: group.id, amount });
    return {
      op: 'capture',
      group: group.id,
      captured: amount,
      remaining: group.amount,
      status: group.status,
      version: this.version,
      normalized: this.normalized(),
    };
  }

  #advance(req) {
    const { now } = req;
    if (!isInt(now) || now < this.now) {
      throw new EngineError('E_PERIOD', `cannot move now backward (${this.now} -> ${now})`, {
        now: this.now,
        requested: now,
      });
    }
    if (now > this.domainEnd) {
      throw new EngineError('E_PERIOD', `now ${now} beyond schedule end ${this.domainEnd}`, {
        now,
        domainEnd: this.domainEnd,
      });
    }
    this.now = now;
    const expired = [];
    for (const g of this.groups.values()) {
      if (g.status !== 'active') continue;
      for (const [id, f] of [...g.fragments]) {
        if (f.end <= now) {
          g.fragments.delete(id);
          expired.push({ group: g.id, fragment: id, end: f.end });
        } else if (f.start < now) {
          // auto-release the elapsed prefix of a straddling fragment
          expired.push({ group: g.id, fragment: id, end: now, truncated: [f.start, now] });
          f.start = now;
        }
      }
      if (g.fragments.size === 0) g.status = 'expired';
    }
    this.version++;
    this.ledger.push({ version: this.version, op: 'advance', now });
    return { op: 'advance', now, expired, version: this.version, normalized: this.normalized() };
  }
}
