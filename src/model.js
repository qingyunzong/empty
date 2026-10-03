// Quota freeze/debit two-phase task model.
//
// Each account has a limit, `used` and `frozen` amounts. The safety invariant
// under verification is: used + frozen <= limit, for every account, in every
// reachable state of every legal schedule.
//
// Every task is a participant with exactly two ordered steps: reserve, then
// complete. Steps of different tasks may interleave arbitrarily.
//
//   freeze(amount)   reserve: frozen += amount        complete: no balance change
//   unfreeze(target) reserve: cancels a *reserved* (not yet completed) freeze,
//                    frozen -= target.amount          complete: no balance change
//   debit(amount)    reserve: frozen += amount        complete: frozen -= amount, used += amount
//   cancelDebit(t)   reserve: cancels a *reserved* (not yet completed) debit,
//                    frozen -= target.amount             complete: no balance change
//
// Reserve steps deliberately do NOT pre-check the limit: the purpose of this
// library is to verify whether a generated task pool can overcommit quota
// under some interleaving, and to exhibit the shortest violating schedule.

export const INVALID_MODEL = 'INVALID_MODEL';

export class ModelError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ModelError';
    this.code = INVALID_MODEL;
  }
}

const KINDS = new Set(['freeze', 'unfreeze', 'debit', 'cancelDebit']);

// Task status codes.
export const ST_PENDING = 0;
export const ST_RESERVED = 1;
export const ST_COMPLETED = 2;
export const ST_CANCELLED = 3; // debit cancelled by cancelDebit (terminal)
export const ST_UNFROZEN = 4; // freeze cancelled by unfreeze (terminal)

export function validatePool(pool) {
  if (!pool || typeof pool !== 'object' || Array.isArray(pool)) {
    throw new ModelError('pool must be an object');
  }
  const { accounts, tasks } = pool;
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new ModelError('pool.accounts must be a non-empty array');
  }
  if (!Array.isArray(tasks)) {
    throw new ModelError('pool.tasks must be an array');
  }
  const accById = new Map();
  for (const account of accounts) {
    if (!account || typeof account.id !== 'string' || account.id.length === 0) {
      throw new ModelError('every account requires a non-empty string id');
    }
    if (accById.has(account.id)) {
      throw new ModelError(`duplicate account id ${account.id}`);
    }
    if (!Number.isInteger(account.limit) || account.limit <= 0) {
      throw new ModelError(`account ${account.id} limit must be a positive integer`);
    }
    accById.set(account.id, account);
  }
  const taskById = new Map();
  for (const task of tasks) {
    if (!task || typeof task.id !== 'string' || task.id.length === 0) {
      throw new ModelError('every task requires a non-empty string id');
    }
    if (taskById.has(task.id)) {
      throw new ModelError(`duplicate task id ${task.id}`);
    }
    if (!KINDS.has(task.kind)) {
      throw new ModelError(`task ${task.id} has unknown kind ${String(task.kind)}`);
    }
    if (!accById.has(task.account)) {
      throw new ModelError(`task ${task.id} references unknown account ${String(task.account)}`);
    }
    taskById.set(task.id, task);
  }
  const cancellerOf = new Map();
  for (const task of tasks) {
    const limit = accById.get(task.account).limit;
    if (task.kind === 'freeze' || task.kind === 'debit') {
      if (!Number.isInteger(task.amount)) {
        throw new ModelError(`task ${task.id} amount must be an integer`);
      }
      if (task.amount <= 0) {
        throw new ModelError(`task ${task.id} amount must be positive`);
      }
      if (task.amount > limit) {
        throw new ModelError(
          `task ${task.id} amount ${task.amount} exceeds limit ${limit} of account ${task.account}`,
        );
      }
    } else {
      const target = taskById.get(task.target);
      if (!target) {
        throw new ModelError(`task ${task.id} references unknown task ${String(task.target)}`);
      }
      const want = task.kind === 'unfreeze' ? 'freeze' : 'debit';
      if (target.kind !== want) {
        throw new ModelError(
          `task ${task.id} (${task.kind}) cannot target ${target.id} (${target.kind})`,
        );
      }
      if (target.account !== task.account) {
        throw new ModelError(
          `task ${task.id} targets task ${target.id} on a different account`,
        );
      }
      if (cancellerOf.has(task.target)) {
        throw new ModelError(
          `task ${task.target} already has canceller ${cancellerOf.get(task.target)}; ` +
            `duplicate completion attempted by ${task.id}`,
        );
      }
      cancellerOf.set(task.target, task.id);
    }
  }
  return pool;
}

// Compiles a validated pool into an indexed model for fast stepping.
export function compilePool(pool) {
  validatePool(pool);
  const accountIndex = new Map(pool.accounts.map((a, i) => [a.id, i]));
  const taskIndex = new Map(pool.tasks.map((t, i) => [t.id, i]));
  const accounts = pool.accounts.map((a) => ({ id: a.id, limit: a.limit }));
  const tasks = pool.tasks.map((t, i) => ({
    index: i,
    id: t.id,
    account: accountIndex.get(t.account),
    kind: t.kind,
    amount: t.kind === 'freeze' || t.kind === 'debit' ? t.amount : null,
    target: t.kind === 'unfreeze' || t.kind === 'cancelDebit' ? taskIndex.get(t.target) : null,
  }));
  return { accounts, tasks };
}

export function initialState(model) {
  return {
    status: new Array(model.tasks.length).fill(ST_PENDING),
    used: new Array(model.accounts.length).fill(0),
    frozen: new Array(model.accounts.length).fill(0),
  };
}

export function stateKey(state) {
  return state.status.join(',');
}

// Steps currently attemptable. Feasibility (lifecycle guards) is decided by
// applyStep, which returns null for an infeasible step.
export function enabledSteps(model, state) {
  const steps = [];
  for (const task of model.tasks) {
    const s = state.status[task.index];
    if (s === ST_PENDING) steps.push({ task: task.index, phase: 'reserve', label: `${task.id}.reserve` });
    else if (s === ST_RESERVED) steps.push({ task: task.index, phase: 'complete', label: `${task.id}.complete` });
  }
  steps.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return steps;
}

// Returns a new state after applying the step, or null if the step is
// infeasible in the current state (lifecycle guard failed).
export function applyStep(model, state, taskIndex, phase) {
  const task = model.tasks[taskIndex];
  const status = state.status.slice();
  const used = state.used.slice();
  const frozen = state.frozen.slice();
  const a = task.account;
  if (phase === 'reserve') {
    if (status[taskIndex] !== ST_PENDING) return null;
    if (task.kind === 'freeze' || task.kind === 'debit') {
      frozen[a] += task.amount;
      status[taskIndex] = ST_RESERVED;
    } else {
      const target = task.target;
      if (status[target] !== ST_RESERVED) return null;
      frozen[a] -= model.tasks[target].amount;
      status[target] = task.kind === 'unfreeze' ? ST_UNFROZEN : ST_CANCELLED;
      status[taskIndex] = ST_RESERVED;
    }
  } else if (phase === 'complete') {
    if (status[taskIndex] !== ST_RESERVED) return null;
    if (task.kind === 'debit') {
      frozen[a] -= task.amount;
      used[a] += task.amount;
    }
    status[taskIndex] = ST_COMPLETED;
  } else {
    return null;
  }
  return { status, used, frozen };
}

// Index of the first account violating used + frozen <= limit, or -1.
export function violatingAccount(model, state) {
  for (let i = 0; i < model.accounts.length; i += 1) {
    if (state.used[i] + state.frozen[i] > model.accounts[i].limit) return i;
  }
  return -1;
}

export function isMaximal(model, state) {
  for (const step of enabledSteps(model, state)) {
    if (applyStep(model, state, step.task, step.phase) !== null) return false;
  }
  return true;
}
