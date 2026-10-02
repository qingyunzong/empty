'use strict';

const { Fraction, ValidationError } = require('./fraction');

function parseNonNegative(value, name) {
  const f = Fraction.parse(value, name);
  if (f.sign() < 0) throw new ValidationError(`${name} 必须非负，得到 ${f}`);
  return f;
}

function parseJitter(jitter) {
  if (jitter === undefined || jitter === null) return [Fraction.zero(), Fraction.zero()];
  if (!Array.isArray(jitter) || jitter.length !== 2) {
    throw new ValidationError('jitter 必须是 [jl, jh] 二元数组');
  }
  const jl = Fraction.parse(jitter[0], 'jitter[0]');
  const jh = Fraction.parse(jitter[1], 'jitter[1]');
  if (jl.gt(jh)) throw new ValidationError(`jitter 下界 ${jl} 大于上界 ${jh}`);
  return [jl, jh];
}

function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  // 左闭右开 [start, end)：边界相等不算冲突
  return aStart.lt(bEnd) && bStart.lt(aEnd);
}

class Scheduler {
  constructor() {
    this.rules = new Map();
    this.reservations = new Map();
    this.history = [];
    this.future = [];
  }

  _snapshot() {
    return { rules: new Map(this.rules), reservations: new Map(this.reservations) };
  }

  _restore(snap) {
    this.rules = snap.rules;
    this.reservations = snap.reservations;
  }

  _commit(label, fn) {
    const before = this._snapshot();
    let result;
    try {
      result = fn();
    } catch (err) {
      this._restore(before); // 事务回滚
      throw err;
    }
    this.history.push({ label, before, after: this._snapshot() });
    this.future = [];
    return result;
  }

  // 多操作原子事务：tx 内任一校验失败则全部回滚
  transaction(label, fn) {
    const tx = {
      addRule: (spec) => this._addRule(spec),
      updateRule: (id, patch) => this._updateRule(id, patch),
      addReservation: (spec) => this._addReservation(spec),
    };
    return this._commit(label, () => fn(tx));
  }

  undo() {
    const entry = this.history.pop();
    if (!entry) return false;
    this._restore(entry.before);
    this.future.push(entry);
    return true;
  }

  redo() {
    const entry = this.future.pop();
    if (!entry) return false;
    this._restore(entry.after);
    this.history.push(entry);
    return true;
  }

  addRule(spec) { return this._commit(`addRule:${spec && spec.id}`, () => this._addRule(spec)); }
  updateRule(id, patch) { return this._commit(`updateRule:${id}`, () => this._updateRule(id, patch)); }
  addReservation(spec) { return this._commit(`addReservation:${spec && spec.id}`, () => this._addReservation(spec)); }

  _validateRuleFields(fields) {
    const phase = parseNonNegative(fields.phase, 'phase');
    const period = parseNonNegative(fields.period, 'period');
    if (period.isZero()) throw new ValidationError('period<=0');
    const duration = parseNonNegative(fields.duration, 'duration');
    const jitter = parseJitter(fields.jitter);
    return { phase, period, duration, jitter };
  }

  _addRule(spec) {
    if (!spec || typeof spec.id !== 'string' || spec.id === '') {
      throw new ValidationError('规则缺少 id');
    }
    if (this.rules.has(spec.id)) throw new ValidationError(`规则 ${spec.id} 已存在`);
    const fields = this._validateRuleFields(spec);
    const rule = { id: spec.id, ...fields };
    this.rules.set(spec.id, rule);
    return { id: spec.id };
  }

  _updateRule(id, patch) {
    const existing = this.rules.get(id);
    if (!existing) throw new ValidationError(`规则 ${id} 不存在`);
    const merged = {
      phase: patch.phase !== undefined ? patch.phase : existing.phase,
      period: patch.period !== undefined ? patch.period : existing.period,
      duration: patch.duration !== undefined ? patch.duration : existing.duration,
      jitter: patch.jitter !== undefined ? patch.jitter : existing.jitter,
    };
    const fields = this._validateRuleFields(merged);
    this.rules.set(id, { id, ...fields });
    return { id };
  }

  _addReservation(spec) {
    if (!spec || typeof spec.id !== 'string' || spec.id === '') {
      throw new ValidationError('预留缺少 id');
    }
    if (this.reservations.has(spec.id)) throw new ValidationError(`预留 ${spec.id} 已存在`);
    const start = Fraction.parse(spec.start, 'start');
    const end = Fraction.parse(spec.end, 'end');
    if (!start.lt(end)) throw new ValidationError(`end<=start: [${start}, ${end})`);
    const priority = spec.priority === undefined ? 0 : spec.priority;
    if (!Number.isInteger(priority)) throw new ValidationError('priority 必须是整数');
    const permit = spec.permit === true;

    const conflicts = [];
    for (const other of this.reservations.values()) {
      if (other.status !== 'active') continue;
      if (intervalsOverlap(start, end, other.start, other.end)) conflicts.push(other);
    }

    const overridden = [];
    if (permit) {
      for (const other of conflicts) {
        if (other.priority < priority) {
          // 不可变替换，保证 undo 快照不被污染
          this.reservations.set(other.id, { ...other, status: 'overridden', overriddenBy: spec.id });
          overridden.push(other.id);
        }
      }
    }

    const reservation = {
      id: spec.id,
      start,
      end,
      priority,
      permit,
      status: 'active',
      overriddenBy: null,
      overrides: overridden, // 被覆盖 id 链（直接覆盖）
    };
    this.reservations.set(spec.id, reservation);
    return { id: spec.id, conflicts: conflicts.map((c) => c.id), overridden };
  }

  // 被覆盖 id 链：直接覆盖 + 传递闭包
  overrideChain(id) {
    const seen = [];
    const visit = (rid) => {
      const res = this.reservations.get(rid);
      if (!res) return;
      for (const child of res.overrides) {
        if (!seen.includes(child)) {
          seen.push(child);
          visit(child);
        }
      }
    };
    visit(id);
    return seen;
  }

  getRule(id) { return this.rules.get(id) || null; }
  getReservation(id) { return this.reservations.get(id) || null; }

  // 在有限视窗 [0, H] 内枚举规则的全部发生实例
  enumerate(ruleId, H) {
    const rule = this.rules.get(ruleId);
    if (!rule) throw new ValidationError(`规则 ${ruleId} 不存在`);
    const horizon = parseNonNegative(H, 'H');
    const instances = [];
    let start = rule.phase;
    let index = 0;
    while (start.lt(horizon)) {
      instances.push({ index, start, end: start.add(rule.duration) });
      start = start.add(rule.period);
      index += 1;
    }
    return instances;
  }

  // 单个实例与预留的冲突分类
  _classifyInstance(rule, instStart, res) {
    const d = rule.duration;
    if (d.isZero()) {
      return { status: 'none' }; // 空区间 [t, t) 不与任何区间冲突
    }
    const [jl, jh] = rule.jitter;
    // 实例区间 [s+j, s+j+d) 与预留 [r, e) 冲突 ⟺ j ∈ (r-s-d, e-s)
    const A = res.start.sub(instStart).sub(d);
    const B = res.end.sub(instStart);
    const lo = Fraction.max(jl, A);
    const hi = Fraction.min(jh, B);
    const nonempty = lo.lt(hi) || (lo.eq(hi) && A.lt(lo) && lo.lt(B));
    if (!nonempty) return { status: 'none' };

    const definite = jl.gt(A) && jh.lt(B);
    const certificate = {
      jitterInterval: [jl, jh],
      conflictWindow: { lo: A, hi: B, open: true }, // 冲突 ⟺ lo < j < hi
      conflictingJitter: { lo, hi }, // 与 [jl, jh] 的交集（开区间端点）
    };
    // 冲突见证点
    if (lo.lt(hi)) {
      certificate.witnessConflict = lo.add(hi).div(new Fraction(2n, 1n));
    } else {
      certificate.witnessConflict = lo;
    }
    if (!definite) {
      // 非确定：给出不冲突的边界见证点
      certificate.witnessNoConflict = jl.lte(A) ? jl : jh;
    }
    return { status: definite ? 'conflict' : 'possible', certificate };
  }

  // 判定预留与所有维护规则实例的冲突
  checkReservation(reservationId, H) {
    const res = this.reservations.get(reservationId);
    if (!res) throw new ValidationError(`预留 ${reservationId} 不存在`);
    const hits = [];
    for (const rule of this.rules.values()) {
      for (const inst of this.enumerate(rule.id, H)) {
        const { status, certificate } = this._classifyInstance(rule, inst.start, res);
        if (status === 'none') continue;
        hits.push({
          rule: rule.id,
          index: inst.index,
          start: inst.start,
          end: inst.end,
          status,
          ...(certificate ? { certificate } : {}),
        });
      }
    }
    let status = 'none';
    if (hits.some((h) => h.status === 'conflict')) status = 'conflict';
    else if (hits.length > 0) status = 'possible';
    return { reservation: reservationId, status, instances: hits };
  }

  checkAll(H) {
    const out = {};
    for (const res of this.reservations.values()) {
      if (res.status !== 'active') continue;
      out[res.id] = this.checkReservation(res.id, H).status;
    }
    return out;
  }
}

module.exports = { Scheduler, ValidationError };
