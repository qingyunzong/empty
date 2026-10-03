'use strict';

// Item lifecycle: pending -> accepted | rejected
//   rejected -> in_rework (rework_start) -> reworked (rework_done)
//   accepted/rejected -> voided (void_inspect, unconsumed judgment)
//   in_rework/reworked -> rejected (void_inspect compensation: reverse_rework)
const STATUS = ['pending', 'accepted', 'rejected', 'in_rework', 'reworked', 'voided'];

const CONTROL_TYPES = new Set(['shutdown', 'restart']);
const EVENT_TYPES = new Set([
  'inspect', 'reject', 'accept',
  'rework_start', 'rework_done', 'void_inspect',
  'shutdown', 'restart',
]);

export class Machine {
  constructor() {
    this.good = 0;       // 正品库存
    this.defective = 0;  // 次品库存（待返工）
    this.rework = 0;     // 返工库存（返工中）
    this.running = true;
    this.items = new Map(); // id -> status
    this.pendingQueue = []; // events arrived while shutdown, original order
    this.moves = [];
    this.errors = [];
    this.inspects = 0;
    this.duplicates = 0; // idempotent no-ops (repeated verdict / repeated void)
    this.nextSeq = 1;
  }

  static load(dump) {
    const m = new Machine();
    m.good = dump.good; m.defective = dump.defective; m.rework = dump.rework;
    m.running = dump.running;
    m.items = new Map(dump.items);
    m.pendingQueue = dump.pendingQueue.map((p) => ({ seq: p.seq, event: p.event }));
    m.moves = dump.moves.map((mv) => ({ ...mv }));
    m.errors = dump.errors.map((e) => ({ ...e }));
    m.inspects = dump.inspects;
    m.duplicates = dump.duplicates;
    m.nextSeq = dump.nextSeq;
    return m;
  }

  dump() {
    return {
      good: this.good, defective: this.defective, rework: this.rework,
      running: this.running,
      items: [...this.items.entries()],
      pendingQueue: this.pendingQueue.map((p) => ({ seq: p.seq, event: p.event })),
      moves: this.moves.map((mv) => ({ ...mv })),
      errors: this.errors.map((e) => ({ ...e })),
      inspects: this.inspects,
      duplicates: this.duplicates,
      nextSeq: this.nextSeq,
    };
  }

  clone() { return Machine.load(this.dump()); }

  // Semantic-state-only clone (no move/error history); used by enumeration.
  cloneBare() {
    const m = new Machine();
    m.good = this.good; m.defective = this.defective; m.rework = this.rework;
    m.running = this.running;
    m.items = new Map(this.items);
    m.pendingQueue = this.pendingQueue.map((p) => ({ seq: p.seq, event: p.event }));
    m.inspects = this.inspectCount();
    m.duplicates = this.duplicates;
    m.nextSeq = this.nextSeq;
    return m;
  }

  inspectCount() { return this.inspects; }

  // Canonical key for dedup; counters are derived from item statuses.
  key() {
    return JSON.stringify({
      r: this.running,
      i: [...this.items.entries()].sort(),
      q: this.pendingQueue.map((p) => [p.seq, p.event]),
    });
  }

  error(seq, code, id, message) {
    const entry = { seq, code, message };
    if (id !== undefined) entry.id = id;
    this.errors.push(entry);
  }

  move(seq, kind, id) {
    const entry = {
      seq, move: kind,
      good: this.good, defective: this.defective, rework: this.rework,
    };
    if (id !== undefined) entry.id = id;
    this.moves.push(entry);
  }

  ingest(event, seq) {
    if (seq === undefined) seq = this.nextSeq;
    this.nextSeq = Math.max(this.nextSeq, seq + 1);

    if (!event || typeof event !== 'object' || Array.isArray(event)
        || typeof event.type !== 'string' || !EVENT_TYPES.has(event.type)) {
      this.error(seq, 'bad_event', undefined,
        'event must be an object with a known "type"');
      return;
    }

    if (CONTROL_TYPES.has(event.type)) {
      this.applyControl(seq, event.type);
      return;
    }
    if (!this.running) {
      // Shutdown: queue in arrival order; merged FIFO on restart, never reordered.
      this.pendingQueue.push({ seq, event });
      return;
    }
    this.apply(seq, event);
  }

  applyControl(seq, type) {
    if (type === 'shutdown') {
      if (!this.running) return; // already down: no-op
      this.running = false;
      this.move(seq, 'shutdown');
      return;
    }
    // restart
    if (this.running) return; // already up: no-op
    this.running = true;
    this.move(seq, 'restart');
    const queued = this.pendingQueue;
    this.pendingQueue = [];
    for (const { seq: qseq, event } of queued) this.apply(qseq, event);
  }

  requireId(seq, event) {
    const id = event.id;
    if (typeof id !== 'string' || id.length === 0) {
      this.error(seq, 'missing_id', undefined, `${event.type} requires a non-empty string "id"`);
      return undefined;
    }
    return id;
  }

  apply(seq, event) {
    switch (event.type) {
      case 'inspect': {
        const id = this.requireId(seq, event);
        if (id === undefined) return;
        if (this.items.has(id)) {
          this.error(seq, 'duplicate_inspect', id, `inspect ${id} already exists`);
          return;
        }
        this.items.set(id, 'pending');
        this.inspects += 1;
        return;
      }
      case 'reject':
      case 'accept': {
        const id = this.requireId(seq, event);
        if (id === undefined) return;
        const status = this.items.get(id);
        if (status === undefined) {
          this.error(seq, event.type === 'reject' ? 'orphan_reject' : 'orphan_accept',
            id, `${event.type} ${id} has no matching inspect`);
          return;
        }
        if (status === 'pending') {
          if (event.type === 'reject') {
            this.items.set(id, 'rejected');
            this.defective += 1;
            this.move(seq, 'reject', id);
          } else {
            this.items.set(id, 'accepted');
            this.good += 1;
            this.move(seq, 'accept', id);
          }
          return;
        }
        // Idempotent: same verdict repeated never changes stock.
        if ((event.type === 'reject' && status === 'rejected')
            || (event.type === 'accept' && status === 'accepted')) {
          this.duplicates += 1;
          return;
        }
        this.error(seq, 'double_consume', id,
          `${event.type} ${id} conflicts with existing state "${status}"`);
        return;
      }
      case 'rework_start': {
        const id = this.requireId(seq, event);
        if (id === undefined) return;
        const status = this.items.get(id);
        if (status === undefined) {
          this.error(seq, 'orphan_rework_start', id, `rework_start ${id} has no matching inspect`);
          return;
        }
        if (status === 'rejected') {
          this.items.set(id, 'in_rework');
          this.defective -= 1;
          this.rework += 1;
          this.move(seq, 'rework_start', id);
          return;
        }
        if (status === 'in_rework') {
          this.error(seq, 'double_consume', id, `rework_start ${id} already in rework`);
          return;
        }
        this.error(seq, 'invalid_state', id,
          `rework_start ${id} requires state "rejected", got "${status}"`);
        return;
      }
      case 'rework_done': {
        const id = this.requireId(seq, event);
        if (id === undefined) return;
        const status = this.items.get(id);
        if (status === undefined) {
          this.error(seq, 'orphan_rework_done', id, `rework_done ${id} has no matching inspect`);
          return;
        }
        if (status === 'in_rework') {
          this.items.set(id, 'reworked');
          this.rework -= 1;
          this.good += 1;
          this.move(seq, 'rework_done', id);
          return;
        }
        if (status === 'reworked') {
          this.error(seq, 'double_consume', id, `rework_done ${id} already completed`);
          return;
        }
        this.error(seq, 'invalid_state', id,
          `rework_done ${id} requires state "in_rework", got "${status}"`);
        return;
      }
      case 'void_inspect': {
        const id = this.requireId(seq, event);
        if (id === undefined) return;
        const status = this.items.get(id);
        if (status === undefined) {
          this.error(seq, 'orphan_void', id, `void_inspect ${id} has no matching inspect`);
          return;
        }
        switch (status) {
          case 'pending':
            this.error(seq, 'no_verdict', id, `void_inspect ${id}: no judgment to revoke`);
            return;
          case 'accepted':
            this.items.set(id, 'voided');
            this.good -= 1;
            this.move(seq, 'void', id);
            return;
          case 'rejected':
            this.items.set(id, 'voided');
            this.defective -= 1;
            this.move(seq, 'void', id);
            return;
          case 'in_rework':
            // Judgment already consumed by rework: history stays, compensate.
            this.items.set(id, 'rejected');
            this.rework -= 1;
            this.defective += 1;
            this.move(seq, 'reverse_rework', id);
            return;
          case 'reworked':
            this.items.set(id, 'rejected');
            this.good -= 1;
            this.defective += 1;
            this.move(seq, 'reverse_rework', id);
            return;
          case 'voided':
            this.duplicates += 1; // idempotent no-op
            return;
          default:
            return;
        }
      }
    }
  }

  invariantsHold() {
    if (this.good < 0 || this.defective < 0 || this.rework < 0) return false;
    let unresolved = 0;
    let voided = 0;
    let good = 0;
    let defective = 0;
    let rework = 0;
    for (const status of this.items.values()) {
      if (!STATUS.includes(status)) return false;
      if (status === 'pending') unresolved += 1;
      else if (status === 'voided') voided += 1;
      else if (status === 'accepted' || status === 'reworked') good += 1;
      else if (status === 'rejected') defective += 1;
      else if (status === 'in_rework') rework += 1;
    }
    if (good !== this.good || defective !== this.defective || rework !== this.rework) return false;
    if (good + defective + rework + voided + unresolved !== this.inspects) return false;
    if (!this.running && this.pendingQueue.length === 0) {
      // allowed only right after shutdown with nothing queued yet — still fine
    }
    if (this.running && this.pendingQueue.length !== 0) return false;
    return true;
  }

  state() {
    return {
      good: this.good,
      defective: this.defective,
      rework: this.rework,
      running: this.running,
      inspects: this.inspects,
      duplicates: this.duplicates,
      errors: this.errors.length,
      items: Object.fromEntries([...this.items.entries()].sort()),
      pending: this.pendingQueue.map((p) => ({ seq: p.seq, event: p.event })),
    };
  }
}

export function runStream(text) {
  const machine = new Machine();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '') continue;
    const seq = i + 1;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      machine.error(seq, 'bad_json', undefined, `line ${seq} is not valid JSON`);
      machine.nextSeq = Math.max(machine.nextSeq, seq + 1);
      continue;
    }
    machine.ingest(event, seq);
  }
  return machine;
}
