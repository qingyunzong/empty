import fs from 'node:fs';
import path from 'node:path';
import { ReplanError } from './errors.js';
import { parseDag, ReadySet } from './dag.js';
import { DIMS, effectiveCost, fits } from './resources.js';

export const STATE_VERSION = 1;
export const DEFAULT_ASSUME_FAIL_RATE = 0.5;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SimulatedCrash extends Error {
  constructor(taskId) {
    super(`simulated crash after checkpoint of task "${taskId}" (before completion was recorded)`);
    this.name = 'SimulatedCrash';
    this.code = 'SIM_CRASH';
    this.taskId = taskId;
  }
}

export function serializeDag(dag) {
  return {
    tasks: [...dag.tasks.values()].map((t) => ({
      id: t.id, deps: [...t.deps], cpu: t.cpu, mem: t.mem, wall: t.wall,
      failRate: t.failRate, maxRetries: t.maxRetries, value: t.value,
    })),
  };
}

export function initState({ dag, budget, planIds, planIndex, seed, assumeFailRate }) {
  return {
    version: STATE_VERSION,
    status: 'running',
    seed,
    assumeFailRate,
    planIndex,
    plan: [...planIds],
    dag: serializeDag(dag),
    budget: { ...budget },
    completed: [],
    attempts: {},
    checkpoints: {},
    effects: [],
    consumed: { cpu: 0, mem: 0, wall: 0 },
    draws: 0,
    pending: null,
    failedTask: null,
    log: [],
  };
}

export function checkpointDir(statePath) {
  return `${statePath}.checkpoints`;
}

export function saveState(statePath, state) {
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath);
}

export function loadState(statePath) {
  let raw;
  try {
    raw = fs.readFileSync(statePath, 'utf8');
  } catch {
    throw new ReplanError('E_INPUT', `cannot read state file: ${statePath}`);
  }
  let s;
  try {
    s = JSON.parse(raw);
  } catch {
    throw new ReplanError('E_INPUT', `corrupt state file: ${statePath}`);
  }
  if (s.version !== STATE_VERSION) {
    throw new ReplanError('E_INPUT', `unsupported state version: ${s.version}`);
  }
  return s;
}

function writeCheckpointFile(statePath, state, taskId, attempt, ok) {
  const dir = checkpointDir(statePath);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${taskId}.${attempt}.json`;
  const data = {
    task: taskId,
    attempt,
    ok,
    completed: [...state.completed],
    consumed: { ...state.consumed },
  };
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2));
  return name;
}

function readCheckpointFile(statePath, name) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(checkpointDir(statePath), name), 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// A task that crashed after writing its checkpoint but before being marked
// complete is finalized from the checkpoint WITHOUT re-applying its side
// effect (the effect was already recorded before the crash).
function finalizePending(statePath, state, ready) {
  const { task, attempt } = state.pending;
  const ck = state.checkpoints[task];
  const data = ck ? readCheckpointFile(statePath, ck.file) : null;
  if (!data || data.task !== task || data.attempt !== attempt) {
    throw new ReplanError('E_LOST_CKPT', `checkpoint lost for task "${task}" attempt ${attempt}`, { task, attempt });
  }
  state.completed.push(task);
  state.pending = null;
  state.log.push({ task, attempt, event: 'resumed-from-checkpoint' });
  ready.complete(task);
}

export function runSimulation(statePath, state, opts = {}) {
  const crashAfter = opts.crashAfterCheckpoint ?? null;
  if (state.status === 'completed' || state.status === 'failed' || state.status === 'budget-exceeded') {
    return state; // terminal states are idempotent
  }
  state.status = 'running';
  const dag = parseDag(state.dag);
  const budget = state.budget;
  const ready = new ReadySet(dag, state.plan);
  for (const id of state.completed) ready.complete(id);
  const prng = mulberry32(state.seed);
  for (let i = 0; i < state.draws; i++) prng(); // keep the draw stream consistent across resumes

  const save = () => saveState(statePath, state);

  if (state.pending) finalizePending(statePath, state, ready);

  let id;
  while ((id = ready.next()) !== null) {
    const t = dag.tasks.get(id);
    const maxAttempts = t.maxRetries + 1;
    let done = false;
    while (!done && (state.attempts[id] ?? 0) < maxAttempts) {
      const attempt = (state.attempts[id] ?? 0) + 1;
      state.attempts[id] = attempt;
      const c = effectiveCost(t, budget);
      for (const d of DIMS) state.consumed[d] += c[d];
      if (!fits(state.consumed, budget)) {
        state.status = 'budget-exceeded';
        state.log.push({ task: id, attempt, event: 'budget-exceeded' });
        save();
        throw new ReplanError('E_BUDGET', `budget exceeded while running task "${id}" (attempt ${attempt})`, {
          consumed: state.consumed, budget,
        });
      }
      const u = prng();
      state.draws += 1;
      const p = t.failRate ?? state.assumeFailRate;
      const ok = u >= p;
      // side effect of the attempt, applied exactly once per attempt
      state.effects.push({ task: id, attempt, ok });
      const file = writeCheckpointFile(statePath, state, id, attempt, ok);
      state.checkpoints[id] = { attempt, file };
      if (ok) {
        if (crashAfter === id) {
          state.pending = { task: id, attempt, stage: 'after-checkpoint' };
          state.status = 'crashed';
          save();
          throw new SimulatedCrash(id);
        }
        state.completed.push(id);
        state.log.push({ task: id, attempt, event: 'completed' });
        ready.complete(id);
        done = true;
      } else {
        state.log.push({ task: id, attempt, event: 'failed' });
      }
      save(); // every attempt boundary is a recovery point
    }
    if (!done) {
      state.status = 'failed';
      state.failedTask = id;
      save();
      return state;
    }
  }
  state.status = 'completed';
  save();
  return state;
}

export function manualCheckpoint(statePath, state, taskId) {
  if (!state.plan.includes(taskId)) {
    throw new ReplanError('E_INPUT', `task "${taskId}" is not part of the plan in this state`);
  }
  if (!state.completed.includes(taskId)) {
    throw new ReplanError('E_INPUT', `task "${taskId}" has not completed; nothing to checkpoint`);
  }
  const dir = checkpointDir(statePath);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${taskId}.manual.json`;
  const data = {
    task: taskId,
    attempt: 'manual',
    ok: true,
    completed: [...state.completed],
    consumed: { ...state.consumed },
  };
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2));
  state.checkpoints[taskId] = { attempt: 'manual', file: name };
  state.log.push({ task: taskId, event: 'manual-checkpoint' });
  saveState(statePath, state);
  return name;
}
