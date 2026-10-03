export class PlannerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function delayOf(task) {
  return Math.max(0, task.end - task.due);
}

export function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

function shareResource(a, b) {
  return a.resources.some((r) => b.resources.includes(r));
}

// Brute-force conflict set over all task pairs (reference implementation).
export function conflictsBrute(tasks) {
  const list = Object.values(tasks);
  const pairs = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (overlaps(list[i], list[j]) && shareResource(list[i], list[j])) {
        pairs.push([list[i].id, list[j].id].sort());
      }
    }
  }
  return pairs.map(([a, b]) => `${a}|${b}`).sort();
}

// Sweep-line per resource; must agree with conflictsBrute.
export function computeConflicts(tasks) {
  const byResource = new Map();
  for (const task of Object.values(tasks)) {
    for (const r of task.resources) {
      if (!byResource.has(r)) byResource.set(r, []);
      byResource.get(r).push(task);
    }
  }
  const found = new Set();
  for (const group of byResource.values()) {
    const sorted = [...group].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    const active = [];
    for (const task of sorted) {
      for (let i = active.length - 1; i >= 0; i--) {
        if (active[i].end <= task.start) active.splice(i, 1);
      }
      for (const other of active) {
        found.add([task.id, other.id].sort().join('|'));
      }
      active.push(task);
    }
  }
  return [...found].sort();
}

export function budgetViolations(tasks, onlyIds = null) {
  const bad = [];
  for (const task of Object.values(tasks)) {
    if (onlyIds && !onlyIds.has(task.id)) continue;
    if (delayOf(task) > task.budget) bad.push(task.id);
  }
  return bad.sort();
}

export function applyOp(tasks, op) {
  const next = structuredClone(tasks);
  switch (op.type) {
    case 'add': {
      if (next[op.task.id]) throw new PlannerError('E_CONFLICT', `task ${op.task.id} already exists`);
      next[op.task.id] = structuredClone(op.task);
      break;
    }
    case 'remove': {
      if (!next[op.taskId]) throw new PlannerError('E_EMPTY', `task ${op.taskId} not found`);
      delete next[op.taskId];
      break;
    }
    case 'shift': {
      const t = next[op.taskId];
      if (!t) throw new PlannerError('E_EMPTY', `task ${op.taskId} not found`);
      t.start += op.delta;
      t.end += op.delta;
      break;
    }
    default:
      throw new PlannerError('E_EMPTY', `unknown op ${op.type}`);
  }
  return next;
}

export function invertOp(tasks, op) {
  switch (op.type) {
    case 'add': return { type: 'remove', taskId: op.task.id };
    case 'remove': return { type: 'add', task: structuredClone(tasks[op.taskId]) };
    case 'shift': return { type: 'shift', taskId: op.taskId, delta: -op.delta };
    default: throw new PlannerError('E_EMPTY', `cannot invert op ${op.type}`);
  }
}

// Tasks touched by the op plus every task sharing a resource and overlapping
// with a touched task in either the before- or after-state.
export function affectedTasks(before, after, touchedIds) {
  const affected = new Set(touchedIds);
  const seeds = touchedIds
    .map((id) => before[id] ?? after[id])
    .filter(Boolean);
  const pool = new Map();
  for (const t of Object.values(before)) pool.set(t.id, t);
  for (const t of Object.values(after)) pool.set(t.id, t);
  for (const candidate of pool.values()) {
    if (affected.has(candidate.id)) continue;
    for (const seed of seeds) {
      if (overlaps(candidate, seed) && shareResource(candidate, seed)) {
        affected.add(candidate.id);
        break;
      }
    }
  }
  return affected;
}

function touchedIdsOf(op) {
  switch (op.type) {
    case 'add': return [op.task.id];
    case 'remove': return [op.taskId];
    case 'shift': return [op.taskId];
    default: return [];
  }
}

// Validate a candidate task set: budget violations and conflicts are only
// possible inside the affected set, so the check is scoped to it.
export function validateTransition(before, after, op) {
  const affected = affectedTasks(before, after, touchedIdsOf(op));
  const violations = budgetViolations(after, affected);
  if (violations.length) {
    throw new PlannerError('E_BUDGET', `budget exceeded for tasks: ${violations.join(', ')}`);
  }
  const conflicts = computeConflicts(after).filter((key) => {
    const [a, b] = key.split('|');
    return affected.has(a) || affected.has(b);
  });
  if (conflicts.length) {
    throw new PlannerError('E_CONFLICT', `resource conflicts: ${conflicts.join(', ')}`);
  }
  return affected;
}

// Best placement for a candidate task. Primary objective: minimal delay;
// ties broken by (1) fewer resources, (2) lexicographic resource list,
// (3) earlier start.
export function bestPlacement(tasks, spec, horizon = 200) {
  const { duration, due, resourceOptions } = spec;
  const starts = new Set([0, Math.max(0, due - duration)]);
  for (const t of Object.values(tasks)) {
    starts.add(t.end);
    if (t.start - duration >= 0) starts.add(t.start - duration);
  }
  const candidates = [];
  for (const resources of resourceOptions) {
    for (const start of starts) {
      const end = start + duration;
      if (start < 0 || end > horizon) continue;
      const ghost = { id: spec.id ?? '?', resources, start, end };
      const clash = Object.values(tasks).some((t) => overlaps(t, ghost) && shareResource(t, ghost));
      if (!clash) {
        candidates.push({ resources, start, end, delay: Math.max(0, end - due) });
      }
    }
  }
  candidates.sort((a, b) =>
    a.delay - b.delay ||
    a.resources.length - b.resources.length ||
    a.resources.join(',').localeCompare(b.resources.join(',')) ||
    a.start - b.start);
  return candidates[0] ?? null;
}
