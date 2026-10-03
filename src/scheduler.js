import { Fraction } from './fraction.js';

const F = (v) => Fraction.parse(v);

function cloneRule(rule) {
  return {
    id: rule.id,
    phase: rule.phase,
    period: rule.period,
    duration: rule.duration,
    jitter: rule.jitter ? [rule.jitter[0], rule.jitter[1]] : null,
  };
}

function cloneReservation(res) {
  return { id: res.id, start: res.start, end: res.end, priority: res.priority, active: res.active };
}

function cloneOverrides(overrides) {
  return overrides.map((o) => ({ high: o.high, overridden: [...o.overridden] }));
}

export class Scheduler {
  constructor(horizon) {
    this.H = F(horizon ?? 0);
    if (this.H.isNegative()) throw new Error('horizon must be non-negative');
    this._rules = new Map();
    this._reservations = new Map();
    this._overrides = [];
    this._past = [];
    this._future = [];
  }

  _snapshot() {
    return {
      rules: new Map([...this._rules].map(([id, r]) => [id, cloneRule(r)])),
      reservations: new Map([...this._reservations].map(([id, r]) => [id, cloneReservation(r)])),
      overrides: cloneOverrides(this._overrides),
    };
  }

  _restore(snap) {
    this._rules = snap.rules;
    this._reservations = snap.reservations;
    this._overrides = snap.overrides;
  }

  _commit(mutate) {
    const snap = this._snapshot();
    try {
      mutate();
    } catch (err) {
      this._restore(snap);
      throw err;
    }
    this._past.push(snap);
    this._future = [];
  }

  undo() {
    if (this._past.length === 0) return false;
    this._future.push(this._snapshot());
    this._restore(this._past.pop());
    return true;
  }

  redo() {
    if (this._future.length === 0) return false;
    this._past.push(this._snapshot());
    this._restore(this._future.pop());
    return true;
  }

  _validateRule(rule) {
    if (!rule.period.isPositive()) throw new Error(`rule ${rule.id}: period must be > 0`);
    if (rule.duration.isNegative()) throw new Error(`rule ${rule.id}: duration must be >= 0`);
    if (rule.phase.isNegative()) throw new Error(`rule ${rule.id}: phase must be >= 0`);
    if (rule.jitter && rule.jitter[0].gt(rule.jitter[1])) {
      throw new Error(`rule ${rule.id}: jitter lower bound exceeds upper bound`);
    }
  }

  addRule({ id, phase, period, duration, jitter }) {
    if (id === undefined) throw new Error('rule id required');
    this._commit(() => {
      if (this._rules.has(id)) throw new Error(`rule ${id} already exists`);
      const rule = {
        id,
        phase: F(phase ?? 0),
        period: F(period),
        duration: F(duration ?? 0),
        jitter: jitter ? [F(jitter[0]), F(jitter[1])] : null,
      };
      this._validateRule(rule);
      this._rules.set(id, rule);
    });
  }

  updateRule(id, patch) {
    this._commit(() => {
      const old = this._rules.get(id);
      if (!old) throw new Error(`rule ${id} not found`);
      const rule = {
        id,
        phase: patch.phase !== undefined ? F(patch.phase) : old.phase,
        period: patch.period !== undefined ? F(patch.period) : old.period,
        duration: patch.duration !== undefined ? F(patch.duration) : old.duration,
        jitter:
          patch.jitter !== undefined
            ? patch.jitter
              ? [F(patch.jitter[0]), F(patch.jitter[1])]
              : null
            : old.jitter,
      };
      this._validateRule(rule);
      this._rules.set(id, rule);
    });
  }

  removeRule(id) {
    this._commit(() => {
      if (!this._rules.has(id)) throw new Error(`rule ${id} not found`);
      this._rules.delete(id);
    });
  }

  addReservation({ id, start, end, priority = 0 }) {
    if (id === undefined) throw new Error('reservation id required');
    this._commit(() => {
      if (this._reservations.has(id)) throw new Error(`reservation ${id} already exists`);
      const s = F(start);
      const e = F(end);
      if (!e.gt(s)) throw new Error(`reservation ${id}: end must be > start`);
      if (s.isNegative()) throw new Error(`reservation ${id}: start must be >= 0`);
      this._reservations.set(id, { id, start: s, end: e, priority: Number(priority), active: true });
    });
  }

  override(highId, lowId, { permit = false } = {}) {
    this._commit(() => {
      if (permit !== true) throw new Error('override requires explicit permit: true');
      const high = this._reservations.get(highId);
      const low = this._reservations.get(lowId);
      if (!high || !high.active) throw new Error(`reservation ${highId} not found or inactive`);
      if (!low || !low.active) throw new Error(`reservation ${lowId} not found or inactive`);
      if (!(high.priority > low.priority)) {
        throw new Error(`reservation ${highId} priority ${high.priority} does not exceed ${lowId} priority ${low.priority}`);
      }
      const chain = [lowId];
      const prior = this._overrides.find((o) => o.high === lowId);
      if (prior) chain.push(...prior.overridden);
      for (const rid of chain) this._reservations.get(rid).active = false;
      this._overrides.push({ high: highId, overridden: chain });
    });
  }

  enumerateInstances(ruleId) {
    const rules = ruleId !== undefined ? [this._rules.get(ruleId)] : [...this._rules.values()];
    const out = [];
    for (const rule of rules) {
      if (!rule) throw new Error(`rule ${ruleId} not found`);
      const q = this.H.sub(rule.phase).div(rule.period);
      if (!q.isPositive()) continue;
      const kMax = q.ceil() - 1n;
      for (let k = 0n; k <= kMax; k++) {
        const start = rule.phase.add(rule.period.mul(new Fraction(k)));
        out.push({ ruleId: rule.id, k: Number(k), start, end: start.add(rule.duration) });
      }
    }
    out.sort((a, b) => a.start.cmp(b.start) || (a.ruleId < b.ruleId ? -1 : 1));
    return out;
  }

  _classifyInstance(res, rule, inst) {
    const s = res.start;
    const e = res.end;
    const a = inst.start;
    const d = rule.duration;
    if (!rule.jitter) {
      return a.lt(e) && s.lt(a.add(d)) ? 'conflict' : 'none';
    }
    const [jl, jh] = rule.jitter;
    const lower = s.sub(a).sub(d);
    const upper = e.sub(a);
    if (!jh.gt(lower) || !jl.lt(upper)) return 'none';
    if (jl.gt(lower) && jh.lt(upper)) return 'conflict';
    const lo = jl.gt(lower) ? jl : lower;
    const hi = jh.lt(upper) ? jh : upper;
    return {
      status: 'possible',
      certificate: {
        ruleId: rule.id,
        k: inst.k,
        instanceStart: a,
        instanceEnd: inst.end,
        jitter: [jl, jh],
        conflictJitterRange: [lo, hi],
        boundary: { lower, upper },
      },
    };
  }

  checkReservation(id) {
    const res = this._reservations.get(id);
    if (!res) throw new Error(`reservation ${id} not found`);
    if (!res.active) {
      const rec = this._overrides.find((o) => o.overridden.includes(id));
      return { id, status: 'overridden', overriddenBy: rec ? rec.high : null };
    }
    const conflicts = [];
    const possibles = [];
    for (const rule of this._rules.values()) {
      for (const inst of this.enumerateInstances(rule.id)) {
        const c = this._classifyInstance(res, rule, inst);
        if (c === 'conflict') {
          conflicts.push({ ruleId: rule.id, k: inst.k, start: inst.start, end: inst.end });
        } else if (c !== 'none') {
          possibles.push(c.certificate);
        }
      }
    }
    const status = conflicts.length > 0 ? 'conflict' : possibles.length > 0 ? 'possible' : 'none';
    return { id, status, conflicts, possible: possibles };
  }

  checkAll() {
    return [...this._reservations.keys()].map((id) => this.checkReservation(id));
  }

  state() {
    return {
      horizon: this.H,
      rules: [...this._rules.values()].map(cloneRule),
      reservations: [...this._reservations.values()].map(cloneReservation),
      overrides: cloneOverrides(this._overrides),
    };
  }
}
