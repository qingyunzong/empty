// Core scheduling engine.
//
// Dependency graph: contract -> period rule -> calendar version -> settlement
// task -> debit batch. Every mutation recomputes only the affected subgraph
// and emits an add/remove diff over future (non-debited) tasks; invalidated
// open batches are reported so downstream consumers can cascade.
//
// Invariants:
//  - debited tasks are immutable; undo happens only via reversal (冲正) tasks
//  - tasks sharing a settled date are ordered by (contractId, period, kind)
//  - end < start is a BAD_RANGE error, never a silently empty plan
import { createHash } from 'node:crypto';
import { addDays, addMonthsClamped, cmp, isValidDate, weekday } from './dates.js';

export class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

// Deterministic task ordering: contractId asc, period asc, charge before reversal.
function keyCmp(ka, kb) {
  const a = ka.split('#');
  const b = kb.split('#');
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  const pa = Number(a[1]);
  const pb = Number(b[1]);
  if (pa !== pb) return pa - pb;
  return (a[2] ? 1 : 0) - (b[2] ? 1 : 0);
}

const MAX_PERIODS = 100000;

export class Engine {
  constructor() {
    this.contracts = new Map(); // id -> {id,type,start,end,ruleId,amount,status}
    this.rules = new Map(); // id -> {id,freq,interval}
    this.calendar = { version: 'v0', holidays: new Set(), skipWeekends: true };
    this.tasks = new Map(); // key -> task
    this.batches = new Map(); // id -> {id,date,tasks,status}
  }

  // ---- calendar ----

  isBusinessDay(date) {
    if (this.calendar.holidays.has(date)) return false;
    if (this.calendar.skipWeekends) {
      const w = weekday(date);
      if (w === 0 || w === 6) return false;
    }
    return true;
  }

  settle(due) {
    let d = due;
    while (!this.isBusinessDay(d)) d = addDays(d, 1);
    return d;
  }

  // ---- schedule generation ----

  scheduleFor(contract) {
    const rule = this.rules.get(contract.ruleId);
    if (!rule) throw new EngineError('UNKNOWN_RULE', `rule ${contract.ruleId} not found`);
    if (!Number.isInteger(rule.interval) || rule.interval < 1) {
      throw new EngineError('BAD_RULE', `rule ${rule.id}: interval must be an integer >= 1`);
    }
    const out = [];
    for (let k = 0; k < MAX_PERIODS; k += 1) {
      let due;
      if (rule.freq === 'monthly') due = addMonthsClamped(contract.start, k * rule.interval);
      else if (rule.freq === 'weekly') due = addDays(contract.start, 7 * k * rule.interval);
      else if (rule.freq === 'daily') due = addDays(contract.start, k * rule.interval);
      else throw new EngineError('BAD_RULE', `rule ${rule.id}: unknown freq ${rule.freq}`);
      if (cmp(due, contract.end) > 0) break;
      out.push({ period: k, due, date: this.settle(due) });
    }
    return out;
  }

  // Differentially re-align one contract's tasks with its desired schedule.
  recomputeContract(contract) {
    const added = [];
    const removed = [];
    const reversals = [];
    const want = contract.status === 'active' ? this.scheduleFor(contract) : [];
    const wantMap = new Map(want.map((w) => [`${contract.id}#${w.period}`, w]));

    for (const t of [...this.tasks.values()]) {
      if (t.contractId !== contract.id || t.kind !== 'charge') continue;
      const w = wantMap.get(t.key);
      if (t.status === 'debited') {
        // Debited tasks are immutable. If the schedule no longer wants them,
        // undo via a reversal task (冲正) booked on the same settled date.
        if (!w) {
          const rkey = `${t.key}#R`;
          if (!this.tasks.has(rkey)) {
            const rev = {
              key: rkey, kind: 'reversal', contractId: t.contractId, period: t.period,
              due: t.due, date: t.date, amount: -t.amount, status: 'pending', reverses: t.key,
            };
            this.tasks.set(rkey, rev);
            reversals.push(rev);
          }
        }
        wantMap.delete(t.key);
        continue;
      }
      if (w && t.due === w.due && t.date === w.date && t.amount === contract.amount) {
        wantMap.delete(t.key); // unchanged
        continue;
      }
      this.tasks.delete(t.key); // changed or no longer wanted
      removed.push(t.key);
    }
    for (const [key, w] of wantMap) {
      const t = {
        key, kind: 'charge', contractId: contract.id, period: w.period,
        due: w.due, date: w.date, amount: contract.amount, status: 'pending',
      };
      this.tasks.set(key, t);
      added.push(t);
    }
    return { added, removed, reversals };
  }

  // Rebuild open batches from pending tasks; debited batches stay frozen.
  rebuildBatches() {
    const added = [];
    const invalidated = [];
    const groups = new Map();
    for (const t of this.tasks.values()) {
      if (t.status !== 'pending') continue;
      const id = `B@${t.date}`;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(t.key);
    }
    for (const [id, b] of [...this.batches]) {
      if (b.status !== 'open') continue;
      const g = groups.get(id);
      const sorted = g ? [...g].sort(keyCmp) : null;
      const same = sorted && sorted.length === b.tasks.length
        && sorted.every((k, i) => k === b.tasks[i]);
      if (!same) {
        this.batches.delete(id);
        invalidated.push(id);
      }
    }
    for (const [id, keys] of [...groups].sort((a, b) => cmp(a[0], b[0]))) {
      if (this.batches.has(id)) continue;
      this.batches.set(id, { id, date: id.slice(2), tasks: [...keys].sort(keyCmp), status: 'open' });
      added.push(id);
    }
    return { added, invalidated };
  }

  #commit(part) {
    const batches = this.rebuildBatches();
    return { ...part, batches, proof: this.proof() };
  }

  #recomputeAll(contractList) {
    const merged = { added: [], removed: [], reversals: [] };
    for (const c of contractList) {
      const d = this.recomputeContract(c);
      merged.added.push(...d.added);
      merged.removed.push(...d.removed);
      merged.reversals.push(...d.reversals);
    }
    return this.#commit(merged);
  }

  // ---- operations (dependency-graph entry points) ----

  addRule(rule) {
    if (!rule || typeof rule.id !== 'string' || rule.id === '') {
      throw new EngineError('BAD_RULE', 'rule.id is required');
    }
    const interval = rule.interval ?? 1;
    if (!['monthly', 'weekly', 'daily'].includes(rule.freq)) {
      throw new EngineError('BAD_RULE', `unknown freq ${rule.freq}`);
    }
    if (!Number.isInteger(interval) || interval < 1) {
      throw new EngineError('BAD_RULE', 'interval must be an integer >= 1');
    }
    this.rules.set(rule.id, { id: rule.id, freq: rule.freq, interval });
    const affected = [...this.contracts.values()].filter((c) => c.ruleId === rule.id);
    return this.#recomputeAll(affected);
  }

  removeRule(id) {
    if (!this.rules.has(id)) throw new EngineError('UNKNOWN_RULE', `rule ${id} not found`);
    if ([...this.contracts.values()].some((c) => c.ruleId === id && c.status === 'active')) {
      throw new EngineError('RULE_IN_USE', `rule ${id} still referenced by an active contract`);
    }
    this.rules.delete(id);
    return this.#commit({ added: [], removed: [], reversals: [] });
  }

  addContract(input) {
    const c = input || {};
    if (typeof c.id !== 'string' || c.id === '' || c.id.includes('#')) {
      throw new EngineError('BAD_CONTRACT', 'contract.id must be a non-empty string without #');
    }
    if (!isValidDate(c.start) || !isValidDate(c.end)) {
      throw new EngineError('BAD_DATE', 'start/end must be valid YYYY-MM-DD dates');
    }
    if (cmp(c.end, c.start) < 0) {
      throw new EngineError('BAD_RANGE', `end ${c.end} is before start ${c.start}`);
    }
    if (this.contracts.has(c.id)) {
      throw new EngineError('DUPLICATE_CONTRACT', `contract ${c.id} already exists`);
    }
    if (!this.rules.has(c.ruleId)) {
      throw new EngineError('UNKNOWN_RULE', `rule ${c.ruleId} not found`);
    }
    if (typeof c.amount !== 'number' || !Number.isFinite(c.amount)) {
      throw new EngineError('BAD_CONTRACT', 'amount must be a finite number');
    }
    const contract = {
      id: c.id, type: c.type === 'subscription' ? 'subscription' : 'loan',
      start: c.start, end: c.end, ruleId: c.ruleId, amount: c.amount, status: 'active',
    };
    this.contracts.set(contract.id, contract);
    return this.#recomputeAll([contract]);
  }

  revokeContract(id) {
    const c = this.contracts.get(id);
    if (!c) throw new EngineError('UNKNOWN_CONTRACT', `contract ${id} not found`);
    c.status = 'revoked';
    return this.#recomputeAll([c]);
  }

  restoreContract(id) {
    const c = this.contracts.get(id);
    if (!c) throw new EngineError('UNKNOWN_CONTRACT', `contract ${id} not found`);
    c.status = 'active';
    return this.#recomputeAll([c]);
  }

  setCalendar(cal) {
    if (!cal || typeof cal.version !== 'string' || cal.version === '') {
      throw new EngineError('BAD_CALENDAR', 'calendar.version is required');
    }
    const holidays = cal.holidays ?? [];
    if (!Array.isArray(holidays) || !holidays.every(isValidDate)) {
      throw new EngineError('BAD_CALENDAR', 'holidays must be valid YYYY-MM-DD dates');
    }
    this.calendar = {
      version: cal.version,
      holidays: new Set(holidays),
      skipWeekends: cal.skipWeekends !== false,
    };
    return this.#recomputeAll([...this.contracts.values()]);
  }

  debitBatch(date) {
    const id = `B@${date}`;
    const b = this.batches.get(id);
    if (!b || b.status !== 'open') {
      throw new EngineError('NO_OPEN_BATCH', `no open batch for ${date}`);
    }
    for (const key of b.tasks) this.tasks.get(key).status = 'debited';
    b.status = 'debited';
    return this.#commit({ added: [], removed: [], reversals: [], debited: { batch: id, tasks: b.tasks } });
  }

  // ---- serialization / proof ----

  serialize() {
    return {
      contracts: [...this.contracts.values()].sort((a, b) => cmp(a.id, b.id)),
      rules: [...this.rules.values()].sort((a, b) => cmp(a.id, b.id)),
      calendar: {
        version: this.calendar.version,
        skipWeekends: this.calendar.skipWeekends,
        holidays: [...this.calendar.holidays].sort(),
      },
      tasks: [...this.tasks.values()].sort((a, b) => keyCmp(a.key, b.key)),
      batches: [...this.batches.values()].sort((a, b) => cmp(a.id, b.id)),
    };
  }

  stateHash() {
    return sha256(canon(this.serialize()));
  }

  proof() {
    return {
      stateHash: this.stateHash(),
      tasks: this.tasks.size,
      batches: this.batches.size,
      calendar: this.calendar.version,
    };
  }
}

// Shared dispatch used by the CLI and by event-log replay.
export function applyOp(engine, cmd) {
  switch (cmd.op) {
    case 'add_rule': return engine.addRule(cmd.rule);
    case 'remove_rule': return engine.removeRule(cmd.id);
    case 'add_contract': return engine.addContract(cmd.contract);
    case 'revoke_contract': return engine.revokeContract(cmd.id);
    case 'restore_contract': return engine.restoreContract(cmd.id);
    case 'set_calendar': return engine.setCalendar(cmd.calendar);
    case 'debit_batch': return engine.debitBatch(cmd.date);
    case 'dump': return { state: engine.serialize(), proof: engine.proof() };
    default: throw new EngineError('UNKNOWN_OP', `unknown op ${cmd.op}`);
  }
}
