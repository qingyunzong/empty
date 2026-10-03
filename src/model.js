// Domain model: normalization, validation, snapshots, and the operation log.

export const INF = Number.MAX_SAFE_INTEGER;

export class ModelError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = 'ModelError';
    this.details = details;
  }
}

function assertInteger(value, label) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ModelError(`${label} must be an integer, got ${JSON.stringify(value)}`);
  }
}

export function normalizeTask(raw, index) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ModelError(`task[${index}] must be an object`);
  }
  const { id, line, duration, release = null, due = null } = raw;
  if (typeof id !== 'string' || id.length === 0) {
    throw new ModelError(`task[${index}].id must be a non-empty string`);
  }
  if (typeof line !== 'string' || line.length === 0) {
    throw new ModelError(`task ${id}: line must be a non-empty string`);
  }
  assertInteger(duration, `task ${id}: duration`);
  if (duration <= 0) throw new ModelError(`task ${id}: duration must be positive`);
  if (release !== null) {
    assertInteger(release, `task ${id}: release`);
    if (release < 0) throw new ModelError(`task ${id}: release must be >= 0`);
  }
  if (due !== null) assertInteger(due, `task ${id}: due`);
  return {
    id,
    line,
    duration,
    release: release === null ? 0 : release,
    due: due === null ? INF : due,
  };
}

export function normalizeCapacity(raw) {
  if (raw === null || raw === undefined) return new Map();
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ModelError('capacity must be an object mapping line -> array of {start,end,capacity}');
  }
  const map = new Map();
  for (const [line, windows] of Object.entries(raw)) {
    if (!Array.isArray(windows)) throw new ModelError(`capacity[${line}] must be an array`);
    const list = windows.map((w, i) => {
      if (w === null || typeof w !== 'object') throw new ModelError(`capacity[${line}][${i}] must be an object`);
      const { start, end, capacity } = w;
      assertInteger(start, `capacity[${line}][${i}].start`);
      assertInteger(end, `capacity[${line}][${i}].end`);
      assertInteger(capacity, `capacity[${line}][${i}].capacity`);
      if (start < 0) throw new ModelError(`capacity[${line}][${i}].start must be >= 0`);
      if (end <= start) throw new ModelError(`capacity[${line}][${i}] must satisfy end > start`);
      if (capacity < 0) throw new ModelError(`capacity[${line}][${i}].capacity must be >= 0`);
      return { start, end, capacity };
    });
    list.sort((a, b) => a.start - b.start || a.end - b.end);
    map.set(line, list);
  }
  return map;
}

export function normalizePrecedence(raw, taskIds) {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ModelError('precedence must be an array of [before, after] pairs');
  return raw.map((pair, i) => {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new ModelError(`precedence[${i}] must be a [before, after] pair`);
    }
    const [before, after] = pair;
    if (!taskIds.has(before)) throw new ModelError(`precedence[${i}]: unknown task ${JSON.stringify(before)}`);
    if (!taskIds.has(after)) throw new ModelError(`precedence[${i}]: unknown task ${JSON.stringify(after)}`);
    if (before === after) throw new ModelError(`precedence[${i}]: self loop on task ${before}`);
    return [before, after];
  });
}

export function detectPrecedenceCycle(edges) {
  const adj = new Map();
  const nodes = new Set();
  for (const [a, b] of edges) {
    nodes.add(a);
    nodes.add(b);
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
  }
  const state = new Map(); // 0=unvisited 1=in-stack 2=done
  const stack = [];
  let cycle = null;
  const dfs = (node) => {
    if (cycle) return;
    state.set(node, 1);
    stack.push(node);
    for (const next of adj.get(node) ?? []) {
      const s = state.get(next) ?? 0;
      if (s === 0) dfs(next);
      else if (s === 1) {
        cycle = stack.slice(stack.indexOf(next)).concat(next);
        return;
      }
      if (cycle) return;
    }
    stack.pop();
    state.set(node, 2);
  };
  for (const node of nodes) {
    if ((state.get(node) ?? 0) === 0) dfs(node);
    if (cycle) break;
  }
  return cycle;
}

export function buildState({ tasks = [], precedence = [], capacity = {} } = {}) {
  const taskMap = new Map();
  for (const [i, raw] of tasks.entries()) {
    const task = normalizeTask(raw, i);
    if (taskMap.has(task.id)) throw new ModelError(`duplicate task id ${JSON.stringify(task.id)}`);
    taskMap.set(task.id, task);
  }
  const edges = normalizePrecedence(precedence, new Set(taskMap.keys()));
  const cycle = detectPrecedenceCycle(edges);
  if (cycle) throw new ModelError(`precedence contains a cycle: ${cycle.join(' -> ')}`);
  return { tasks: taskMap, precedence: edges, capacity: normalizeCapacity(capacity) };
}

export function cloneState(state) {
  const tasks = new Map();
  for (const [id, t] of state.tasks) tasks.set(id, { ...t });
  const capacity = new Map();
  for (const [line, windows] of state.capacity) {
    capacity.set(line, windows.map((w) => ({ ...w })));
  }
  return { tasks, precedence: state.precedence.map((p) => [...p]), capacity };
}

// ---------------------------------------------------------------------------
// Operation log

export class OperationLog {
  constructor() {
    this.entries = [];
    this.pointer = 0; // number of applied entries; entries[pointer..] are redoable
  }

  record(label, before, after) {
    this.entries.length = this.pointer; // drop redo tail
    this.entries.push({ label, before: cloneState(before), after: cloneState(after) });
    this.pointer = this.entries.length;
  }

  get length() {
    return this.pointer;
  }

  get canUndo() {
    return this.pointer > 0;
  }

  get canRedo() {
    return this.pointer < this.entries.length;
  }

  undo() {
    if (!this.canUndo) return null;
    this.pointer -= 1;
    const entry = this.entries[this.pointer];
    return { label: entry.label, state: cloneState(entry.before) };
  }

  redo() {
    if (!this.canRedo) return null;
    const entry = this.entries[this.pointer];
    this.pointer += 1;
    return { label: entry.label, state: cloneState(entry.after) };
  }
}
