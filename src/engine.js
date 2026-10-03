import { ReconError } from './errors.js';
import { stableStringify } from './canon.js';
import { classifyDiffs, diffsToTasks, applyRepair } from './diff.js';
import { History } from './history.js';
import { Scheduler } from './scheduler.js';
import { AuditLog } from './audit.js';
import { Journal } from './journal.js';

export function serializeSnapshot(entries) {
  const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (sorted.length === 0) return Buffer.alloc(0);
  return Buffer.from(sorted.map(stableStringify).join('\n') + '\n', 'utf8');
}

export function deserializeSnapshot(bytes) {
  const text = Buffer.from(bytes).toString('utf8');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

const CONFLICT_CODES = new Set(['SEALED', 'CONFLICT_DOMAIN', 'BAD_DIFF']);

// One reconcile pass = each worker slot executes at most one task.
// Tasks that do not win a slot stay pending for the next pass.
export class RepairEngine {
  constructor({ ledger = [], snapshot = [], slots = 1, merchantQuota = Infinity, journal = null } = {}) {
    this.ledger = ledger;
    this.entries = snapshot.map((e) => ({ ...e }));
    this.scheduler = new Scheduler({ slots, merchantQuota });
    this.history = new History();
    this.audit = new AuditLog();
    this.journal = journal;
    this.clock = 0;
    this.seq = 0;
    this.undoStack = [];
    this.appliedIds = new Set();
  }

  snapshotBytes() {
    return serializeSnapshot(this.entries);
  }

  seal(account, day) {
    this.history.seal(account, day);
    this.audit.append({ type: 'seal', domain: History.domainKey(account, day) });
  }

  makeEvent(task) {
    this.clock += 1;
    this.seq += 1;
    const event = {
      id: task.id,
      account: task.account,
      day: task.day,
      lamport: this.clock,
      source: 'reconciler',
      seq: this.seq,
      kind: 'repair',
    };
    if (task.supersedes) event.supersedes = task.supersedes;
    return event;
  }

  applyTask(task, event) {
    const next = applyRepair(this.entries, task.repair); // BAD_DIFF before any journaling
    const before = this.snapshotBytes();
    const after = serializeSnapshot(next);
    if (this.journal) {
      this.journal.plan(task.id, { repair: task.repair, domain: task.domain, after: after.toString('utf8') });
    }
    this.entries = next;
    this.undoStack.push({ taskId: task.id, before });
    this.appliedIds.add(task.id);
    this.audit.append({
      type: 'repair',
      task: task.id,
      domain: task.domain,
      lamport: event.lamport,
      seq: event.seq,
    });
    if (this.journal) this.journal.commit(task.id);
  }

  reconcile() {
    const diffs = classifyDiffs(this.ledger, this.entries);
    const tasks = diffsToTasks(diffs);
    for (const task of tasks) {
      if (this.appliedIds.has(task.id)) continue;
      if (this.scheduler.running.has(task.id) || this.scheduler.pending.has(task.id)) continue;
      this.scheduler.submit(task);
    }
    this.scheduler.promote();

    const repaired = [];
    const conflicts = [];
    let task;
    while ((task = this.scheduler.nextRunning()) !== null) {
      try {
        const event = this.makeEvent(task);
        this.history.record(event); // SEALED / CONFLICT_DOMAIN
        this.applyTask(task, event);
        repaired.push(task.id);
      } catch (err) {
        if (err instanceof ReconError && CONFLICT_CODES.has(err.code)) {
          conflicts.push({ task: task.id, code: err.code, domain: task.domain, message: err.message });
        } else {
          throw err;
        }
      } finally {
        this.scheduler.complete(task.id);
      }
    }
    return { repaired, pending: this.scheduler.pendingIds(), conflicts, auditRoot: this.audit.auditRoot };
  }

  // Restore the exact snapshot bytes captured before the repair was applied.
  undo(taskId) {
    const idx = this.undoStack.findIndex((e) => e.taskId === taskId);
    if (idx === -1) {
      throw new ReconError('BAD_DIFF', `cannot undo ${taskId}: not in the applied-repair stack`);
    }
    const [entry] = this.undoStack.splice(idx, 1);
    this.entries = deserializeSnapshot(entry.before);
    this.appliedIds.delete(taskId);
    this.audit.append({ type: 'undo', task: taskId });
    return { undone: taskId };
  }

  // Idempotent replay of committed plans; plans without a commit are discarded.
  recoverFromJournal(path) {
    for (const { id, payload } of Journal.committedPlans(path)) {
      if (this.appliedIds.has(id)) continue;
      this.entries = deserializeSnapshot(Buffer.from(payload.after, 'utf8'));
      this.appliedIds.add(id);
      this.audit.append({ type: 'recover', task: id, domain: payload.domain });
    }
    return this.snapshotBytes();
  }
}
