'use strict';

function isNonNegInt(value) {
  return Number.isInteger(value) && value >= 0;
}

function normalizeTask(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('task must be an object');
  }
  const id = raw.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('task.id must be a non-empty string');
  }
  const line = raw.line;
  if (typeof line !== 'string' || line.length === 0) {
    throw new Error(`task ${id}: line must be a non-empty string`);
  }
  const duration = raw.duration;
  if (!Number.isInteger(duration) || duration <= 0) {
    throw new Error(`task ${id}: duration must be a positive integer`);
  }
  const release = raw.release === null || raw.release === undefined ? 0 : raw.release;
  if (!isNonNegInt(release)) {
    throw new Error(`task ${id}: release must be null or a non-negative integer`);
  }
  const due = raw.due === null || raw.due === undefined ? null : raw.due;
  if (due !== null && !isNonNegInt(due)) {
    throw new Error(`task ${id}: due must be null or a non-negative integer`);
  }
  return { id, line, duration, release, due };
}

function normalizeCapacityValue(line, slot, value) {
  if (!isNonNegInt(value)) {
    throw new Error(`capacity ${line}:${slot} must be a non-negative integer`);
  }
  return value;
}

function normalizeCapacity(raw) {
  const capacity = {};
  for (const [line, slots] of Object.entries(raw ?? {})) {
    if (slots === null || typeof slots !== 'object' || Array.isArray(slots)) {
      throw new Error(`capacity for line ${line} must be an object mapping slot to capacity`);
    }
    const normalized = {};
    for (const [slot, value] of Object.entries(slots)) {
      if (slot !== '*' && !/^\d+$/.test(slot)) {
        throw new Error(`capacity slot key for line ${line} must be "*" or a non-negative integer, got: ${slot}`);
      }
      normalized[slot] = normalizeCapacityValue(line, slot, value);
    }
    capacity[line] = normalized;
  }
  return capacity;
}

function normalizeProblem(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('problem must be a JSON object');
  }
  if (!Array.isArray(input.tasks)) {
    throw new Error('problem.tasks must be an array');
  }
  const tasks = new Map();
  for (const raw of input.tasks) {
    const task = normalizeTask(raw);
    if (tasks.has(task.id)) {
      throw new Error(`duplicate task id: ${task.id}`);
    }
    tasks.set(task.id, task);
  }
  const precedence = [];
  const seenEdges = new Set();
  for (const edge of input.precedence ?? []) {
    if (!Array.isArray(edge) || edge.length !== 2) {
      throw new Error('precedence entries must be [before, after] pairs');
    }
    const [before, after] = edge;
    if (!tasks.has(before)) throw new Error(`precedence references unknown task: ${before}`);
    if (!tasks.has(after)) throw new Error(`precedence references unknown task: ${after}`);
    if (before === after) throw new Error(`self precedence on task: ${before}`);
    const key = before + '' + after;
    if (!seenEdges.has(key)) {
      seenEdges.add(key);
      precedence.push([before, after]);
    }
  }
  const capacity = normalizeCapacity(input.capacity);
  const defaultCapacity = input.defaultCapacity === undefined ? 1 : input.defaultCapacity;
  if (!isNonNegInt(defaultCapacity)) {
    throw new Error('defaultCapacity must be a non-negative integer');
  }
  return { tasks, precedence, capacity, defaultCapacity };
}

function problemToJSON(problem) {
  return {
    tasks: [...problem.tasks.values()].map((t) => ({
      id: t.id,
      line: t.line,
      duration: t.duration,
      release: t.release,
      due: t.due,
    })),
    precedence: problem.precedence.map((e) => [...e]),
    capacity: structuredClone(problem.capacity),
    defaultCapacity: problem.defaultCapacity,
  };
}

module.exports = { normalizeProblem, normalizeTask, problemToJSON, isNonNegInt };
