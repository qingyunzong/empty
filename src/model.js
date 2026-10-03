// Quota freeze model.
//
// Each account has a `limit`; the safety invariant is `used + frozen <= limit`.
// Every task has two ordered steps: reserve (R) then complete (C).
//
//   freeze      R: hold `amount` in frozen            C: frozen -> used
//   unfreeze    R: cancel an incomplete (reserved) freeze, releasing its hold
//               C: bookkeeping only
//   debit       R: hold `amount` of available quota   C: hold -> used
//   cancelDebit R: restore the hold of an incomplete debit
//               C: bookkeeping only
//
// Any illegal application (unknown task, out-of-order or duplicate step,
// over-limit input, cancelling a settled task) is rejected with INVALID_MODEL.

export class InvalidModelError extends Error {
  constructor(reason) {
    super(`INVALID_MODEL: ${reason}`);
    this.name = 'InvalidModelError';
    this.code = 'INVALID_MODEL';
  }
}

export const TASK_STATE = Object.freeze({
  PENDING: 'pending',
  RESERVED: 'reserved',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
});

export const PHASE = Object.freeze({ RESERVE: 'R', COMPLETE: 'C' });

const KINDS = new Set(['freeze', 'unfreeze', 'debit', 'cancelDebit']);

export class Model {
  constructor(accounts, tasks, options = {}) {
    this.enforceLimit = options.enforceLimit !== false;
    this.accounts = accounts.map((a, i) => ({ id: a.id ?? `A${i}`, limit: a.limit }));
    this.tasks = tasks.map((t) => ({ ...t }));
    this.taskIndex = new Map();
    this.tasks.forEach((t, i) => {
      if (this.taskIndex.has(t.id)) {
        throw new InvalidModelError(`duplicate task id ${t.id}`);
      }
      this.taskIndex.set(t.id, i);
    });
    for (const task of this.tasks) {
      this.validateTask(task);
    }
    this.reset();
  }

  validateTask(task) {
    const account = this.accounts[task.account];
    if (!account) {
      throw new InvalidModelError(`task ${task.id} references unknown account ${task.account}`);
    }
    if (!KINDS.has(task.kind)) {
      throw new InvalidModelError(`task ${task.id} has unknown kind ${task.kind}`);
    }
    if (!Number.isInteger(task.amount) || task.amount < 1) {
      throw new InvalidModelError(`task ${task.id} has invalid amount ${task.amount}`);
    }
    if (task.amount > account.limit) {
      throw new InvalidModelError(
        `task ${task.id} amount ${task.amount} exceeds limit ${account.limit}`,
      );
    }
    if (task.kind === 'unfreeze' || task.kind === 'cancelDebit') {
      const targetIdx = this.taskIndex.get(task.target);
      if (targetIdx === undefined) {
        throw new InvalidModelError(`task ${task.id} targets unknown task ${task.target}`);
      }
      const target = this.tasks[targetIdx];
      const required = task.kind === 'unfreeze' ? 'freeze' : 'debit';
      if (target.kind !== required) {
        throw new InvalidModelError(`task ${task.id} must target a ${required} task`);
      }
      if (target.account !== task.account) {
        throw new InvalidModelError(`task ${task.id} and target ${task.target} use different accounts`);
      }
      if (target.amount !== task.amount) {
        throw new InvalidModelError(`task ${task.id} amount differs from target ${task.target}`);
      }
    }
  }

  reset() {
    this.taskState = this.tasks.map(() => TASK_STATE.PENDING);
    this.used = this.accounts.map(() => 0);
    this.frozen = this.accounts.map(() => 0);
  }

  snapshot() {
    return {
      taskState: [...this.taskState],
      used: [...this.used],
      frozen: [...this.frozen],
    };
  }

  restore(snap) {
    this.taskState = [...snap.taskState];
    this.used = [...snap.used];
    this.frozen = [...snap.frozen];
  }

  key() {
    return [
      this.taskState.map((s) => s[0] + (s === TASK_STATE.COMPLETED ? 'd' : s === TASK_STATE.CANCELLED ? 'x' : '')),
      this.used,
      this.frozen,
    ].flat().join('|');
  }

  invariantHolds() {
    return this.accounts.every(
      (a, i) => this.used[i] >= 0 && this.frozen[i] >= 0 && this.used[i] + this.frozen[i] <= a.limit,
    );
  }

  check(taskId, phase) {
    const idx = this.taskIndex.get(taskId);
    if (idx === undefined) {
      throw new InvalidModelError(`unknown task ${taskId}`);
    }
    const task = this.tasks[idx];
    const state = this.taskState[idx];
    if (phase === PHASE.RESERVE) {
      if (state !== TASK_STATE.PENDING) {
        throw new InvalidModelError(`task ${taskId} cannot reserve in state ${state}`);
      }
      if (task.kind === 'freeze' || task.kind === 'debit') {
        const a = task.account;
        if (this.enforceLimit && this.used[a] + this.frozen[a] + task.amount > this.accounts[a].limit) {
          throw new InvalidModelError(
            `task ${taskId} reserve of ${task.amount} exceeds limit ${this.accounts[a].limit}`,
          );
        }
      } else {
        const targetIdx = this.taskIndex.get(task.target);
        if (this.taskState[targetIdx] !== TASK_STATE.RESERVED) {
          const noun = task.kind === 'unfreeze' ? 'freeze' : 'debit';
          throw new InvalidModelError(
            `task ${taskId} requires an incomplete ${noun} ${task.target} (state ${this.taskState[targetIdx]})`,
          );
        }
      }
      return;
    }
    if (phase === PHASE.COMPLETE) {
      if (state === TASK_STATE.COMPLETED) {
        throw new InvalidModelError(`duplicate complete for task ${taskId}`);
      }
      if (state !== TASK_STATE.RESERVED) {
        throw new InvalidModelError(`task ${taskId} cannot complete in state ${state}`);
      }
      return;
    }
    throw new InvalidModelError(`unknown phase ${phase}`);
  }

  applicable(taskId, phase) {
    try {
      this.check(taskId, phase);
      return true;
    } catch (err) {
      if (err.code === 'INVALID_MODEL') return false;
      throw err;
    }
  }

  apply(taskId, phase) {
    this.check(taskId, phase);
    const idx = this.taskIndex.get(taskId);
    const task = this.tasks[idx];
    if (phase === PHASE.RESERVE) {
      if (task.kind === 'freeze' || task.kind === 'debit') {
        this.frozen[task.account] += task.amount;
        this.taskState[idx] = TASK_STATE.RESERVED;
      } else {
        const targetIdx = this.taskIndex.get(task.target);
        const target = this.tasks[targetIdx];
        this.frozen[target.account] -= target.amount;
        this.taskState[targetIdx] = TASK_STATE.CANCELLED;
        this.taskState[idx] = TASK_STATE.RESERVED;
      }
      return;
    }
    if (task.kind === 'freeze' || task.kind === 'debit') {
      this.frozen[task.account] -= task.amount;
      this.used[task.account] += task.amount;
    }
    this.taskState[idx] = TASK_STATE.COMPLETED;
  }

  stepLabel(taskId, phase) {
    return `${taskId}:${phase}`;
  }

  enabledSteps() {
    const labels = [];
    for (const task of this.tasks) {
      if (this.applicable(task.id, PHASE.RESERVE)) labels.push(this.stepLabel(task.id, PHASE.RESERVE));
      if (this.applicable(task.id, PHASE.COMPLETE)) labels.push(this.stepLabel(task.id, PHASE.COMPLETE));
    }
    return labels.sort();
  }
}
