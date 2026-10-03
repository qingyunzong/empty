'use strict';

const { noSlot } = require('./errors');

function priorityOf(task) {
  return [-task.severity, task.deadline, task.taskId];
}

function comparePriority(a, b) {
  if (a.severity !== b.severity) return b.severity - a.severity; // higher severity first
  if (a.deadline !== b.deadline) return a.deadline < b.deadline ? -1 : 1; // earlier deadline first
  return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
}

// Bounded worker-slot scheduler with merchant quotas.
// Preemption is allowed ONLY against tasks flagged undoable.
class Scheduler {
  constructor({ slots, merchantQuota } = {}) {
    if (!Number.isInteger(slots) || slots < 1) throw new Error('slots must be a positive integer');
    this.slots = slots;
    this.merchantQuota = merchantQuota || {}; // merchantId -> max running tasks
    this.running = new Map(); // taskId -> task
  }

  quotaFor(merchantId) {
    return this.merchantQuota[merchantId] ?? Infinity;
  }

  runningForMerchant(merchantId) {
    let n = 0;
    for (const t of this.running.values()) if (t.merchantId === merchantId) n += 1;
    return n;
  }

  freeSlots() { return this.slots - this.running.size; }

  // Try to start a task. Returns 'started' | 'preempted' | throws NO_SLOT.
  // On preemption the victim is returned via out.preempted.
  acquire(task, out = {}) {
    if (this.running.has(task.taskId)) return 'started';
    if (this.runningForMerchant(task.merchantId) >= this.quotaFor(task.merchantId)) {
      throw noSlot(`merchant quota reached for ${task.merchantId}`, {
        merchantId: task.merchantId, quota: this.quotaFor(task.merchantId),
      });
    }
    if (this.freeSlots() > 0) {
      this.running.set(task.taskId, task);
      return 'started';
    }
    // All slots busy: only undoable running tasks with strictly lower priority
    // may be preempted, and the victim's merchant quota must not be exceeded
    // (quota counts stay same since we swap within a slot).
    const candidates = [...this.running.values()]
      .filter((t) => t.undoable && comparePriority(task, t) < 0)
      .sort(comparePriority)
      .reverse(); // lowest priority first
    const victim = candidates[0];
    if (!victim) {
      throw noSlot('all worker slots busy and no preemptible (undoable) task', {
        slots: this.slots,
        running: [...this.running.keys()],
      });
    }
    this.running.delete(victim.taskId);
    this.running.set(task.taskId, task);
    out.preempted = victim;
    return 'preempted';
  }

  release(taskId) {
    return this.running.delete(taskId);
  }

  runningTasks() {
    return [...this.running.values()].sort(comparePriority);
  }
}

module.exports = { Scheduler, comparePriority, priorityOf };
