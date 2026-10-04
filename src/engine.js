import { createHash } from 'node:crypto';
import { occurrences, parseDate, EngineError } from './schedule.js';
import { makeCalendar, adjust } from './calendar.js';

// Dependency graph (contract -> period rule -> calendar version -> settlement
// task -> debit batch) is maintained implicitly: any mutation recomputes the
// desired task set for affected contracts and diffs it against the
// materialized set, then propagates invalidation to open batches.
//
// Invariants:
//  - paid tasks are immutable; removal pressure creates a reversal instead
//  - same-day tasks order by (dueDate, contractId, period, kind)
//  - end < start raises BAD_RANGE, never a silent empty plan
export class Engine {
  constructor() {
    this.contracts = new Map(); // id -> {id,type,start,end,freq,interval,amount,revoked}
    this.calendar = makeCalendar();
    this.calendarVersion = 0;
    this.tasks = new Map(); // taskId -> task
    this.batches = new Map(); // batchId -> {id,cutoff,status,taskIds}
  }

  apply(op) {
    if (!op || typeof op.op !== 'string') {
      throw new EngineError('BAD_OP', 'missing op');
    }
    switch (op.op) {
      case 'add_contract': return this.#addContract(op);
      case 'revoke_contract': return this.#revoke(op);
      case 'restore_contract': return this.#restore(op);
      case 'add_holiday': return this.#addHoliday(op);
      case 'set_calendar': return this.#setCalendar(op);
      case 'create_batch': return this.#createBatch(op);
      case 'execute_batch': return this.#executeBatch(op);
      default: throw new EngineError('BAD_OP', `unknown op: ${op.op}`);
    }
  }

  #addContract(op) {
    const { id, start, end, freq } = op;
    if (!id) throw new EngineError('BAD_CONTRACT', 'contract id required');
    if (this.contracts.has(id) && !this.contracts.get(id).revoked) {
      throw new EngineError('DUPLICATE_CONTRACT', `contract ${id} already active`);
    }
    parseDate(start); parseDate(end);
    if (end < start) throw new EngineError('BAD_RANGE', `end ${end} is before start ${start}`);
    const contract = {
      id,
      type: op.type === 'subscription' ? 'subscription' : 'loan',
      start, end, freq,
      interval: op.interval ?? 1,
      amount: op.amount ?? 0,
      revoked: false,
    };
    // validate eagerly so a bad rule never yields a silent empty plan
    for (const _ of occurrences(contract)) void _;
    this.contracts.set(id, contract);
    return this.#result('add_contract', this.#recompute());
  }

  #revoke(op) {
    const c = this.#contract(op.id);
    c.revoked = true;
    return this.#result('revoke_contract', this.#recompute());
  }

  #restore(op) {
    const c = this.#contract(op.id);
    c.revoked = false;
    return this.#result('restore_contract', this.#recompute());
  }

  #addHoliday(op) {
    parseDate(op.date);
    this.calendar.holidays.add(op.date);
    this.calendarVersion += 1;
    return this.#result('add_holiday', this.#recompute());
  }

  #setCalendar(op) {
    this.calendar = makeCalendar({ holidays: op.holidays ?? [], weekends: op.weekends ?? [0, 6] });
    this.calendarVersion += 1;
    return this.#result('set_calendar', this.#recompute());
  }

  #createBatch(op) {
    if (!op.id) throw new EngineError('BAD_BATCH', 'batch id required');
    if (this.batches.has(op.id)) throw new EngineError('DUPLICATE_BATCH', `batch ${op.id} exists`);
    parseDate(op.cutoff);
    this.batches.set(op.id, { id: op.id, cutoff: op.cutoff, status: 'open', taskIds: [] });
    const batches = this.#rebuildOpenBatches();
    return this.#result('create_batch', { diff: EMPTY_DIFF, batches });
  }

  #executeBatch(op) {
    const b = this.batches.get(op.id);
    if (!b) throw new EngineError('UNKNOWN_BATCH', `batch ${op.id}`);
    if (b.status !== 'open') throw new EngineError('BATCH_EXECUTED', `batch ${op.id} already executed`);
    for (const tid of b.taskIds) {
      const t = this.tasks.get(tid);
      if (t) t.status = 'paid';
    }
    b.status = 'executed';
    return this.#result('execute_batch', { diff: EMPTY_DIFF, batches: {} });
  }

  #contract(id) {
    const c = this.contracts.get(id);
    if (!c) throw new EngineError('UNKNOWN_CONTRACT', `contract ${id}`);
    return c;
  }

  // ---- recompute / diff -------------------------------------------------

  desiredTasks() {
    const desired = new Map();
    for (const c of this.contracts.values()) {
      if (c.revoked) continue;
      let period = 0;
      for (const date of occurrences(c)) {
        desired.set(`${c.id}#${period}`, {
          id: `${c.id}#${period}`,
          kind: 'charge',
          contractId: c.id,
          period,
          dueDate: adjust(this.calendar, date),
          amount: c.amount,
        });
        period += 1;
      }
    }
    return desired;
  }

  #recompute() {
    const desired = this.desiredTasks();
    const diff = { added: [], removed: [], updated: [], reversed: [] };
    for (const t of [...this.tasks.values()]) {
      if (t.kind !== 'charge' || desired.has(t.id)) continue;
      if (t.status === 'paid') {
        // paid tasks are immutable: issue a reversal (冲正) instead
        const revId = `REV:${t.id}`;
        if (!this.tasks.has(revId)) {
          this.tasks.set(revId, {
            id: revId, kind: 'reversal', contractId: t.contractId, period: t.period,
            dueDate: t.dueDate, amount: -t.amount, status: 'pending', reverses: t.id,
          });
          diff.reversed.push(revId);
        }
      } else {
        this.tasks.delete(t.id);
        diff.removed.push(t.id);
      }
    }
    for (const [id, d] of desired) {
      const cur = this.tasks.get(id);
      if (!cur) {
        this.tasks.set(id, { ...d, status: 'pending' });
        diff.added.push(id);
      } else if (cur.status !== 'paid' && cur.dueDate !== d.dueDate) {
        diff.updated.push({ id, from: cur.dueDate, to: d.dueDate });
        cur.dueDate = d.dueDate;
      }
    }
    const batches = this.#rebuildOpenBatches();
    return { diff, batches };
  }

  // Invalidation propagation: open batches re-derive membership in creation
  // order; executed batches are immutable.
  #rebuildOpenBatches() {
    const claimed = new Set();
    for (const b of this.batches.values()) {
      if (b.status === 'executed') for (const tid of b.taskIds) claimed.add(tid);
    }
    const diffs = {};
    for (const b of this.batches.values()) {
      if (b.status !== 'open') continue;
      const eligible = this.sortedTasks()
        .filter((t) => t.status === 'pending' && t.dueDate <= b.cutoff && !claimed.has(t.id))
        .map((t) => t.id);
      const added = eligible.filter((x) => !b.taskIds.includes(x));
      const removed = b.taskIds.filter((x) => !eligible.includes(x));
      b.taskIds = eligible;
      for (const tid of eligible) claimed.add(tid);
      if (added.length || removed.length) diffs[b.id] = { added, removed };
    }
    return diffs;
  }

  // ---- views ------------------------------------------------------------

  sortedTasks() {
    return [...this.tasks.values()].sort((a, b) =>
      a.dueDate.localeCompare(b.dueDate) ||
      a.contractId.localeCompare(b.contractId) ||
      a.period - b.period ||
      a.kind.localeCompare(b.kind));
  }

  proof() {
    const canonical = this.sortedTasks().map((t) => [t.id, t.dueDate, t.amount, t.status, t.kind]);
    return {
      tasks: this.tasks.size,
      calendarVersion: this.calendarVersion,
      hash: createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
    };
  }

  #result(op, { diff, batches }) {
    return { ok: true, op, diff, batches, proof: this.proof() };
  }
}

const EMPTY_DIFF = { added: [], removed: [], updated: [], reversed: [] };
