// Model: validation, canonicalization and deterministic hashing of the
// maintenance scheduling problem state.
//
// Canonical state shape:
// {
//   crews:  integer >= 1 (default 2),
//   budget: integer >= 0,
//   parts:  { partId: integer >= 0 }            (keys sorted),
//   tasks:  [ { id, deps: [ids sorted], modes: [ { duration, cost, parts: {} } ] } ]
//           sorted by task id.
// }

export class ProblemError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ProblemError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function isNonNegInt(v) {
  return Number.isInteger(v) && v >= 0;
}

function fail(code, message, details) {
  throw new ProblemError(code, message, details);
}

function validatePartsMap(parts, knownParts, ctx) {
  if (parts === undefined || parts === null) return {};
  if (typeof parts !== 'object' || Array.isArray(parts)) {
    fail('INVALID_SCHEMA', `${ctx}: parts must be an object mapping part id to quantity`);
  }
  const out = {};
  for (const key of Object.keys(parts).sort()) {
    const qty = parts[key];
    if (!knownParts || !Object.prototype.hasOwnProperty.call(knownParts, key)) {
      fail('UNKNOWN_PART', `${ctx}: unknown spare part "${key}"`, { part: key });
    }
    if (!isNonNegInt(qty)) {
      fail('INVALID_SCHEMA', `${ctx}: quantity of part "${key}" must be a non-negative integer`);
    }
    if (qty > 0) out[key] = qty;
  }
  return out;
}

export function validateTask(raw, knownParts, ctx = 'task') {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail('INVALID_SCHEMA', `${ctx}: task must be an object`);
  }
  if (typeof raw.id !== 'string' || raw.id.length === 0) {
    fail('INVALID_SCHEMA', `${ctx}: task id must be a non-empty string`);
  }
  const id = raw.id;
  let deps = raw.deps === undefined ? [] : raw.deps;
  if (!Array.isArray(deps) || deps.some((d) => typeof d !== 'string' || d.length === 0)) {
    fail('INVALID_SCHEMA', `task "${id}": deps must be an array of task id strings`);
  }
  deps = [...new Set(deps)].sort();
  if (!Array.isArray(raw.modes) || raw.modes.length === 0) {
    fail('INVALID_SCHEMA', `task "${id}": modes must be a non-empty array`);
  }
  const modes = raw.modes.map((m, i) => {
    const mctx = `task "${id}" mode ${i}`;
    if (typeof m !== 'object' || m === null || Array.isArray(m)) {
      fail('INVALID_SCHEMA', `${mctx}: mode must be an object`);
    }
    if (!isNonNegInt(m.duration)) {
      fail('INVALID_SCHEMA', `${mctx}: duration must be a non-negative integer`);
    }
    if (!isNonNegInt(m.cost)) {
      fail('INVALID_SCHEMA', `${mctx}: cost must be a non-negative integer`);
    }
    return {
      duration: m.duration,
      cost: m.cost,
      parts: validatePartsMap(m.parts, knownParts, mctx),
    };
  });
  return { id, deps, modes };
}

export function detectCycle(taskIds, depsOf) {
  // Iterative DFS, deterministic order. Returns a cycle as array of ids, or null.
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(taskIds.map((id) => [id, WHITE]));
  const stack = [];
  for (const start of taskIds) {
    if (color.get(start) !== WHITE) continue;
    const frames = [{ id: start, next: 0 }];
    color.set(start, GRAY);
    stack.push(start);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const deps = depsOf(frame.id);
      if (frame.next < deps.length) {
        const dep = deps[frame.next++];
        const c = color.get(dep);
        if (c === GRAY) {
          const idx = stack.indexOf(dep);
          return [...stack.slice(idx), dep];
        }
        if (c === WHITE) {
          color.set(dep, GRAY);
          stack.push(dep);
          frames.push({ id: dep, next: 0 });
        }
      } else {
        color.set(frame.id, BLACK);
        stack.pop();
        frames.pop();
      }
    }
  }
  return null;
}

export function validateProblem(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    fail('INVALID_SCHEMA', 'input must be a JSON object');
  }
  if (typeof input.budget !== 'number' || !Number.isInteger(input.budget)) {
    fail('INVALID_SCHEMA', 'budget must be an integer');
  }
  if (input.budget < 0) {
    fail('NEGATIVE_BUDGET', `budget must be non-negative, got ${input.budget}`, { budget: input.budget });
  }
  let crews = input.crews === undefined ? 2 : input.crews;
  if (!Number.isInteger(crews) || crews < 1 || crews > 8) {
    fail('INVALID_SCHEMA', 'crews must be an integer between 1 and 8');
  }
  const rawParts = input.parts === undefined ? {} : input.parts;
  if (typeof rawParts !== 'object' || rawParts === null || Array.isArray(rawParts)) {
    fail('INVALID_SCHEMA', 'parts must be an object mapping part id to available quantity');
  }
  const parts = {};
  for (const key of Object.keys(rawParts).sort()) {
    if (!isNonNegInt(rawParts[key])) {
      fail('INVALID_SCHEMA', `parts["${key}"] must be a non-negative integer`);
    }
    parts[key] = rawParts[key];
  }
  if (!Array.isArray(input.tasks)) {
    fail('INVALID_SCHEMA', 'tasks must be an array');
  }
  const seen = new Set();
  const tasks = input.tasks.map((raw, i) => {
    const task = validateTask(raw, parts, `tasks[${i}]`);
    if (seen.has(task.id)) {
      fail('DUPLICATE_TASK', `duplicate task id "${task.id}"`, { task: task.id });
    }
    seen.add(task.id);
    return task;
  });
  tasks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const state = { crews, budget: input.budget, parts, tasks };
  checkDependencies(state);
  return state;
}

export function checkDependencies(state) {
  const ids = new Set(state.tasks.map((t) => t.id));
  for (const task of state.tasks) {
    for (const dep of task.deps) {
      if (!ids.has(dep)) {
        fail('UNKNOWN_DEPENDENCY', `task "${task.id}" depends on unknown task "${dep}"`, {
          task: task.id,
          dependency: dep,
        });
      }
    }
  }
  const depsOf = new Map(state.tasks.map((t) => [t.id, t.deps]));
  const cycle = detectCycle(state.tasks.map((t) => t.id), (id) => depsOf.get(id));
  if (cycle) {
    fail('CYCLIC_DAG', `dependency cycle detected: ${cycle.join(' -> ')}`, { cycle });
  }
}

// Deterministic canonical serialization (all collections already sorted).
export function hashState(state) {
  return JSON.stringify(state);
}

export function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

// Longest precedence chain (by total duration of chosen modes) — the critical path.
export function criticalPath(state, modeOf) {
  const tasks = state.tasks;
  const idx = new Map(tasks.map((t, i) => [t.id, i]));
  const memo = new Array(tasks.length).fill(null);
  const best = (i) => {
    if (memo[i]) return memo[i];
    const task = tasks[i];
    let bestPred = null;
    for (const dep of task.deps) {
      const cand = best(idx.get(dep));
      if (!bestPred || cand.len > bestPred.len) bestPred = cand;
    }
    const dur = task.modes[modeOf(task.id)].duration;
    const len = (bestPred ? bestPred.len : 0) + dur;
    const path = [...(bestPred ? bestPred.path : []), task.id];
    memo[i] = { len, path };
    return memo[i];
  };
  let top = { len: 0, path: [] };
  for (let i = 0; i < tasks.length; i++) {
    const cand = best(i);
    if (cand.len > top.len) top = cand;
  }
  return top;
}
