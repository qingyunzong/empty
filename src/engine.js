'use strict';

const { classifyDiff, DIFF_KINDS, validateEntry } = require('./diff');
const { Scheduler, comparePriority } = require('./scheduler');
const { History, LamportClock } = require('./history');
const { SealRegistry } = require('./seal');
const { AuditLog } = require('./audit');
const { JournalStore } = require('./store');
const { CODES, ReconcileError, noSlot } = require('./errors');

const SEVERITY_BY_KIND = Object.freeze({
  [DIFF_KINDS.AMOUNT_MISMATCH]: 3,
  [DIFF_KINDS.MISSING_IN_SNAPSHOT]: 2,
  [DIFF_KINDS.MISSING_IN_LEDGER]: 2,
  [DIFF_KINDS.CURRENCY_MISMATCH]: 2,
  [DIFF_KINDS.STATUS_MISMATCH]: 1,
  [DIFF_KINDS.ATTRIBUTE_MISMATCH]: 1,
});

// Canonical, byte-stable serialization of the snapshot.
function serializeSnapshot(entries) {
  const ids = [...entries.keys()].sort();
  const parts = ids.map((id) => {
    const e = entries.get(id);
    return JSON.stringify({
      id: e.id, accountId: e.accountId, day: e.day,
      amount: e.amount, currency: e.currency, status: e.status,
    });
  });
  return `[\n${parts.join(',\n')}\n]`;
}

function deserializeSnapshot(text) {
  const arr = JSON.parse(text);
  const map = new Map();
  for (const e of arr) map.set(e.id, e);
  return map;
}

class Engine {
  constructor({ slots = 2, merchantQuota = {}, store = null, source = 'engine' } = {}) {
    this.source = source;
    this.clock = new LamportClock();
    this.seq = 0;
    this.ledger = new Map();
    this.snapshot = new Map();
    this.seals = new SealRegistry();
    this.history = new History();
    this.scheduler = new Scheduler({ slots, merchantQuota });
    this.audit = new AuditLog();
    this.store = store;
    this.tasks = new Map();       // taskId -> task
    this.repaired = [];           // applied repair records
    this.conflicts = [];          // CONFLICT_DOMAIN records
    this.taskCounter = 0;
  }

  static snapshotBytesOf(entries) { return serializeSnapshot(entries); }

  nextEvent(accountId, day) {
    this.seq += 1;
    return { lamport: this.clock.tick(), source: this.source, seq: this.seq, accountId, day };
  }

  // --- ledger ingestion (late entries hit the seal registry) ---
  ingestLedger(entries) {
    const accepted = [];
    for (const entry of entries) {
      validateEntry(entry, 'ledger');
      const { superseded } = this.seals.admitLate(entry);
      if (superseded) {
        this.ledger.delete(superseded.id);
        this.audit.append({ type: 'supersede', from: superseded.id, to: entry.id });
      }
      this.ledger.set(entry.id, entry);
      this.seals.register(entry);
      accepted.push(entry.id);
    }
    return accepted;
  }

  loadSnapshot(entries) {
    for (const entry of entries) validateEntry(entry, 'snapshot');
    this.snapshot = new Map(entries.map((e) => [e.id, e]));
  }

  sealDay(accountId, day) {
    this.seals.seal(accountId, day);
    this.audit.append({ type: 'seal', accountId, day });
  }

  // --- reconciliation: diffs become repair tasks ---
  reconcile({ accountId, day, deadline } = {}) {
    const ledger = [...this.ledger.values()].filter(
      (e) => (!accountId || e.accountId === accountId) && (!day || e.day === day));
    const snapshot = [...this.snapshot.values()].filter(
      (e) => (!accountId || e.accountId === accountId) && (!day || e.day === day));
    const diffs = classifyDiff(ledger, snapshot);
    const tasks = [];
    for (const diff of diffs) {
      this.taskCounter += 1;
      const ref = diff.ledger || diff.snapshot;
      const task = {
        taskId: `task-${this.taskCounter}`,
        diffId: diff.id,
        kind: diff.kind,
        accountId: ref.accountId,
        day: ref.day,
        merchantId: ref.merchantId || 'default',
        severity: SEVERITY_BY_KIND[diff.kind],
        deadline: deadline || `${ref.day}T23:59:59Z`,
        undoable: true,
        status: 'pending',
        error: null,
      };
      this.tasks.set(task.taskId, task);
      tasks.push(task);
      this.audit.append({ type: 'task-created', taskId: task.taskId, kind: task.kind, diffId: diff.id });
    }
    return tasks;
  }

  // --- scheduling ---
  schedulePending() {
    const pending = [...this.tasks.values()]
      .filter((t) => t.status === 'pending')
      .sort(comparePriority);
    const started = [];
    for (const task of pending) {
      const out = {};
      try {
        const result = this.scheduler.acquire(task, out);
        task.status = 'running';
        if (result === 'preempted') this.#preempt(out.preempted, task);
        started.push(task.taskId);
      } catch (err) {
        if (err instanceof ReconcileError && err.code === CODES.NO_SLOT) {
          task.error = CODES.NO_SLOT;
          continue; // stays pending
        }
        throw err;
      }
    }
    return started;
  }

  #preempt(victim, byTask) {
    if (!victim.undoable) throw noSlot('victim is not undoable', { victim: victim.taskId });
    if (victim.status === 'applied') this.undo(victim.taskId);
    victim.status = 'pending';
    victim.error = null;
    this.audit.append({ type: 'preempt', victim: victim.taskId, by: byTask.taskId });
  }

  // --- repair application ---
  applyTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    if (task.status === 'applied') return task; // idempotent
    if (task.status !== 'running') {
      const out = {};
      let result;
      try {
        result = this.scheduler.acquire(task, out);
      } catch (err) {
        if (err instanceof ReconcileError && err.code === CODES.NO_SLOT) {
          task.error = CODES.NO_SLOT;
          return task; // stays pending
        }
        throw err;
      }
      if (result === 'preempted') this.#preempt(out.preempted, task);
      task.status = 'running';
    }
    const event = { ...this.nextEvent(task.accountId, task.day), taskId };
    try {
      this.history.admit(event);
    } catch (err) {
      if (err instanceof ReconcileError && err.code === CODES.CONFLICT_DOMAIN) {
        task.status = 'failed';
        task.error = CODES.CONFLICT_DOMAIN;
        this.scheduler.release(taskId);
        this.conflicts.push({ taskId, domain: `${task.accountId}|${task.day}`, detail: err.details });
        this.audit.append({ type: 'conflict', taskId, code: CODES.CONFLICT_DOMAIN });
        return task;
      }
      throw err;
    }

    const before = serializeSnapshot(this.snapshot);
    this.#applyDiffEffect(task);
    const after = serializeSnapshot(this.snapshot);

    const planId = `plan-${taskId}`;
    if (this.store) {
      // Failure point 1: crash here (plan written, no commit) -> plan discarded on recovery.
      this.store.writePlan({ planId, taskId, event, before, after });
      this.#mutateTo(after);
      // Failure point 2: crash here (commit written) -> replay must be idempotent.
      this.store.writeCommit(planId);
    }

    task.status = 'applied';
    task.error = null;
    // The applied repair keeps holding its worker slot: it may still be
    // preempted (and undone) by a higher-priority task. undo() frees the slot.
    this.repaired.push({ taskId, undoable: task.undoable, before, after, event });
    this.audit.append({ type: 'repair-applied', taskId, event });
    return task;
  }

  #applyDiffEffect(task) {
    const ledgerEntry = this.ledger.get(task.diffId);
    const snapshotEntry = this.snapshot.get(task.diffId);
    switch (task.kind) {
      case DIFF_KINDS.MISSING_IN_SNAPSHOT:
        this.snapshot.set(task.diffId, { ...ledgerEntry });
        break;
      case DIFF_KINDS.MISSING_IN_LEDGER:
        this.snapshot.delete(task.diffId);
        break;
      case DIFF_KINDS.AMOUNT_MISMATCH:
      case DIFF_KINDS.CURRENCY_MISMATCH:
      case DIFF_KINDS.STATUS_MISMATCH:
      case DIFF_KINDS.ATTRIBUTE_MISMATCH:
        this.snapshot.set(task.diffId, { ...snapshotEntry, ...ledgerEntry });
        break;
      default:
        throw new Error(`unknown diff kind ${task.kind}`);
    }
  }

  #mutateTo(snapshotText) {
    this.snapshot = deserializeSnapshot(snapshotText);
  }

  // --- undo: restore snapshot byte-exactly ---
  undo(taskId) {
    const idx = this.repaired.findIndex((r) => r.taskId === taskId);
    if (idx === -1) throw new Error(`no applied repair ${taskId}`);
    const repair = this.repaired[idx];
    if (!repair.undoable) throw new Error(`repair ${taskId} is not undoable`);
    this.#mutateTo(repair.before); // byte-exact restore of the pre-repair snapshot
    this.repaired.splice(idx, 1);
    this.scheduler.release(taskId);
    const task = this.tasks.get(taskId);
    if (task) task.status = 'undone';
    this.audit.append({ type: 'undo', taskId });
    return repair.before;
  }

  snapshotBytes() { return serializeSnapshot(this.snapshot); }

  pendingTasks() {
    return [...this.tasks.values()].filter((t) => t.status === 'pending' || t.status === 'undone');
  }

  report() {
    return {
      repaired: this.repaired.map((r) => r.taskId),
      pending: this.pendingTasks().map((t) => t.taskId),
      conflicts: this.conflicts.map((c) => ({ taskId: c.taskId, domain: c.domain })),
      auditRoot: this.audit.root(),
    };
  }

  // --- recovery: replay committed plans idempotently ---
  static recover({ store, slots = 2, merchantQuota = {}, source = 'engine' }) {
    const engine = new Engine({ slots, merchantQuota, store, source });
    const plans = store.readCommittedPlans(); // uncommitted plans discarded here
    const state = store.loadState();
    if (state && state.ledger) engine.ledger = new Map(state.ledger.map((e) => [e.id, e]));
    for (const plan of plans) {
      if (engine.repaired.some((r) => r.taskId === plan.taskId)) continue; // idempotent
      engine.#mutateTo(plan.after);
      engine.history.admit(plan.event);
      engine.clock.observe(plan.event.lamport);
      engine.seq = Math.max(engine.seq, plan.event.seq);
      engine.repaired.push({
        taskId: plan.taskId, undoable: true, before: plan.before, after: plan.after, event: plan.event,
      });
      engine.audit.append({ type: 'replay', taskId: plan.taskId, planId: plan.planId });
    }
    return engine;
  }

  persistState() {
    if (!this.store) return;
    this.store.saveState({ ledger: [...this.ledger.values()] });
  }
}

module.exports = { Engine, JournalStore, serializeSnapshot, deserializeSnapshot, SEVERITY_BY_KIND };
