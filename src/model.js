'use strict';

const DEFAULT_DEFER_PENALTY = 10000;
const MAX_TASKS = 64;

class ValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPosNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function compareIds(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortObject(obj) {
  const out = {};
  for (const key of Object.keys(obj).sort(compareIds)) out[key] = obj[key];
  return out;
}

function validateTask(raw, partNames) {
  if (!isPlainObject(raw)) {
    throw new ValidationError('INVALID_TASK', 'each task must be an object');
  }
  const id = raw.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new ValidationError('INVALID_TASK_ID', 'task id must be a non-empty string');
  }
  const deps = raw.deps === undefined ? [] : raw.deps;
  if (!Array.isArray(deps) || deps.some((d) => typeof d !== 'string' || d.length === 0)) {
    throw new ValidationError('INVALID_DEPENDENCY', `task ${id}: deps must be an array of task id strings`);
  }
  if (new Set(deps).size !== deps.length) {
    throw new ValidationError('DUPLICATE_DEPENDENCY', `task ${id}: duplicate dependency`);
  }
  const downtime = raw.downtime === undefined ? 1 : raw.downtime;
  if (!isNonNegNumber(downtime)) {
    throw new ValidationError('INVALID_DOWNTIME', `task ${id}: downtime weight must be a non-negative number`);
  }
  const deferPenalty = raw.deferPenalty === undefined ? DEFAULT_DEFER_PENALTY : raw.deferPenalty;
  if (!isNonNegNumber(deferPenalty)) {
    throw new ValidationError('INVALID_DEFER_PENALTY', `task ${id}: deferPenalty must be a non-negative number`);
  }
  if (!Array.isArray(raw.modes) || raw.modes.length === 0) {
    throw new ValidationError('INVALID_MODES', `task ${id}: modes must be a non-empty array`);
  }
  const seenModes = new Set();
  const modes = raw.modes.map((m) => {
    if (!isPlainObject(m)) {
      throw new ValidationError('INVALID_MODE', `task ${id}: each mode must be an object`);
    }
    if (typeof m.id !== 'string' || m.id.length === 0) {
      throw new ValidationError('INVALID_MODE_ID', `task ${id}: mode id must be a non-empty string`);
    }
    if (seenModes.has(m.id)) {
      throw new ValidationError('DUPLICATE_MODE_ID', `task ${id}: duplicate mode id ${m.id}`);
    }
    seenModes.add(m.id);
    if (!isPosNumber(m.duration)) {
      throw new ValidationError('INVALID_DURATION', `task ${id}/${m.id}: duration must be a positive number`);
    }
    if (!isNonNegNumber(m.cost)) {
      throw new ValidationError('INVALID_COST', `task ${id}/${m.id}: cost must be a non-negative number`);
    }
    const parts = m.parts === undefined ? {} : m.parts;
    if (!isPlainObject(parts)) {
      throw new ValidationError('INVALID_MODE_PARTS', `task ${id}/${m.id}: parts must be an object`);
    }
    for (const [part, qty] of Object.entries(parts)) {
      if (!partNames.has(part)) {
        throw new ValidationError('UNKNOWN_PART', `task ${id}/${m.id}: unknown spare part "${part}"`);
      }
      if (!isPosNumber(qty)) {
        throw new ValidationError('INVALID_PART_QUANTITY', `task ${id}/${m.id}: part "${part}" quantity must be a positive number`);
      }
    }
    return { id: m.id, duration: m.duration, cost: m.cost, parts: sortObject(parts) };
  });
  modes.sort((a, b) => compareIds(a.id, b.id));
  return {
    id,
    deps: [...deps].sort(compareIds),
    downtime,
    deferPenalty,
    modes,
  };
}

function topologicalOrder(tasks) {
  const indexOf = new Map(tasks.map((t, i) => [t.id, i]));
  const indegree = tasks.map((t) => t.deps.length);
  const succs = tasks.map(() => []);
  tasks.forEach((t, i) => {
    for (const d of t.deps) succs[indexOf.get(d)].push(i);
  });
  // Kahn with deterministic (sorted-by-id) ready set.
  const ready = tasks.filter((_, i) => indegree[i] === 0).map((t) => t.id).sort(compareIds);
  const order = [];
  while (ready.length > 0) {
    const id = ready.shift();
    order.push(id);
    const newly = [];
    for (const s of succs[indexOf.get(id)]) {
      indegree[s] -= 1;
      if (indegree[s] === 0) newly.push(tasks[s].id);
    }
    newly.sort(compareIds);
    // merge keeping ready sorted
    for (const nid of newly) {
      let pos = ready.length;
      while (pos > 0 && ready[pos - 1] > nid) pos -= 1;
      ready.splice(pos, 0, nid);
    }
  }
  if (order.length !== tasks.length) {
    const remaining = tasks.filter((t) => !order.includes(t.id)).map((t) => t.id);
    throw new ValidationError('CYCLIC_DAG', `dependency graph contains a cycle involving: ${remaining.join(', ')}`);
  }
  return order;
}

function validateProblem(raw) {
  if (!isPlainObject(raw)) {
    throw new ValidationError('INVALID_INPUT', 'problem must be a JSON object');
  }
  const budget = raw.budget;
  if (typeof budget !== 'number' || !Number.isFinite(budget)) {
    throw new ValidationError('INVALID_BUDGET', 'budget must be a finite number');
  }
  if (budget < 0) {
    throw new ValidationError('NEGATIVE_BUDGET', `budget must be non-negative, got ${budget}`);
  }
  const crews = raw.crews === undefined ? 2 : raw.crews;
  if (!Number.isInteger(crews) || crews < 1 || crews > 8) {
    throw new ValidationError('INVALID_CREWS', 'crews must be an integer between 1 and 8');
  }
  const parts = raw.parts === undefined ? {} : raw.parts;
  if (!isPlainObject(parts)) {
    throw new ValidationError('INVALID_PARTS', 'parts must be an object mapping part name to inventory quantity');
  }
  for (const [name, qty] of Object.entries(parts)) {
    if (!isNonNegNumber(qty)) {
      throw new ValidationError('INVALID_PART_INVENTORY', `part "${name}": inventory must be a non-negative number`);
    }
  }
  const partNames = new Set(Object.keys(parts));
  if (!Array.isArray(raw.tasks)) {
    throw new ValidationError('INVALID_TASKS', 'tasks must be an array');
  }
  if (raw.tasks.length > MAX_TASKS) {
    throw new ValidationError('TOO_MANY_TASKS', `at most ${MAX_TASKS} tasks are supported`);
  }
  const seen = new Set();
  const tasks = raw.tasks.map((t) => {
    const task = validateTask(t, partNames);
    if (seen.has(task.id)) {
      throw new ValidationError('DUPLICATE_TASK_ID', `duplicate task id "${task.id}"`);
    }
    seen.add(task.id);
    return task;
  });
  for (const task of tasks) {
    for (const dep of task.deps) {
      if (dep === task.id) {
        throw new ValidationError('CYCLIC_DAG', `task "${task.id}" depends on itself`);
      }
      if (!seen.has(dep)) {
        throw new ValidationError('UNKNOWN_DEPENDENCY', `task "${task.id}" depends on unknown task "${dep}"`);
      }
    }
  }
  tasks.sort((a, b) => compareIds(a.id, b.id));
  const topoOrder = topologicalOrder(tasks);
  return {
    budget,
    crews,
    parts: sortObject(parts),
    tasks,
    topoOrder,
  };
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort(compareIds);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

module.exports = {
  DEFAULT_DEFER_PENALTY,
  MAX_TASKS,
  ValidationError,
  validateProblem,
  stableStringify,
  compareIds,
};
