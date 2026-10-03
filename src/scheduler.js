import { ReconError } from './errors.js';

// Priority: severity desc, then deadline asc, then id asc (deterministic).
export function compareTasks(a, b) {
  if (a.severity !== b.severity) return b.severity - a.severity;
  if (a.deadline !== b.deadline) return a.deadline < b.deadline ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function validateTask(task) {
  for (const f of ['id', 'merchant', 'severity', 'deadline', 'domain']) {
    if (task[f] === undefined) throw new ReconError('BAD_DIFF', `task missing "${f}"`);
  }
  if (typeof task.severity !== 'number') throw new ReconError('BAD_DIFF', 'task.severity must be a number');
}

// Bounded worker slots + per-merchant running quota.
// Preemption is allowed ONLY against tasks marked undoable.
export class Scheduler {
  constructor({ slots = 1, merchantQuota = Infinity } = {}) {
    if (!Number.isInteger(slots) || slots < 0) throw new ReconError('NO_SLOT', 'slots must be a non-negative integer');
    this.slots = slots;
    this.merchantQuota = merchantQuota;
    this.running = new Map();
    this.pending = new Map();
  }

  merchantRunning(merchant) {
    let n = 0;
    for (const t of this.running.values()) if (t.merchant === merchant) n += 1;
    return n;
  }

  canRun(task) {
    return this.running.size < this.slots && this.merchantRunning(task.merchant) < this.merchantQuota;
  }

  // Lowest-priority running task that is undoable, strictly lower priority
  // than `task`, and whose preemption keeps the merchant quota satisfiable.
  findPreemptable(task) {
    const candidates = [...this.running.values()]
      .filter((t) => t.undoable === true && compareTasks(task, t) < 0)
      .sort(compareTasks)
      .reverse();
    for (const victim of candidates) {
      const freedSameMerchant = victim.merchant === task.merchant ? 1 : 0;
      if (this.merchantRunning(task.merchant) - freedSameMerchant < this.merchantQuota) return victim;
    }
    return null;
  }

  // Returns { status: 'running', preempted? } or { status: 'pending' }.
  // With strict: true, throws NO_SLOT instead of queueing.
  submit(task, { strict = false } = {}) {
    validateTask(task);
    if (this.running.has(task.id) || this.pending.has(task.id)) {
      throw new ReconError('BAD_DIFF', `duplicate task id ${task.id}`);
    }
    if (this.canRun(task)) {
      this.running.set(task.id, task);
      return { status: 'running' };
    }
    const victim = this.findPreemptable(task);
    if (victim) {
      this.running.delete(victim.id);
      this.pending.set(victim.id, victim);
      this.running.set(task.id, task);
      return { status: 'running', preempted: victim.id };
    }
    if (strict) {
      throw new ReconError(
        'NO_SLOT',
        `no worker slot for task ${task.id} and no undoable lower-priority task to preempt`,
        { task: task.id },
      );
    }
    this.pending.set(task.id, task);
    return { status: 'pending' };
  }

  // Highest-priority running task (execution order).
  nextRunning() {
    const all = [...this.running.values()].sort(compareTasks);
    return all[0] ?? null;
  }

  complete(id) {
    this.running.delete(id);
  }

  // Fill free slots from pending, in priority order, respecting quota.
  promote() {
    const promoted = [];
    for (const task of [...this.pending.values()].sort(compareTasks)) {
      if (!this.canRun(task)) continue;
      this.pending.delete(task.id);
      this.running.set(task.id, task);
      promoted.push(task.id);
    }
    return promoted;
  }

  pendingIds() {
    return [...this.pending.values()].sort(compareTasks).map((t) => t.id);
  }
}
