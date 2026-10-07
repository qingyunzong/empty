import { createHash } from 'node:crypto';

export class InputError extends Error {
  constructor(code, message, id) {
    super(message);
    this.name = 'InputError';
    this.code = code;
    if (id !== undefined) this.id = id;
  }
}

export const idCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function validateConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InputError('INVALID', 'config must be an object');
  }
  const slots = raw.slots ?? 1;
  const capacity = raw.capacity ?? 1;
  const agingFactor = raw.agingFactor ?? 1;
  if (!Number.isInteger(slots) || slots < 1) {
    throw new InputError('INVALID', `config.slots must be a positive integer, got ${JSON.stringify(slots)}`);
  }
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new InputError('INVALID', `config.capacity must be a positive integer, got ${JSON.stringify(capacity)}`);
  }
  if (typeof agingFactor !== 'number' || !Number.isFinite(agingFactor) || agingFactor < 0) {
    throw new InputError('INVALID', 'config.agingFactor must be a non-negative number');
  }
  const rawQuotas = raw.quotas ?? {};
  if (rawQuotas === null || typeof rawQuotas !== 'object' || Array.isArray(rawQuotas)) {
    throw new InputError('INVALID', 'config.quotas must be an object mapping institution to integer quota');
  }
  const quotas = {};
  for (const key of Object.keys(rawQuotas).sort(idCompare)) {
    const q = rawQuotas[key];
    if (!Number.isInteger(q) || q < 0) {
      throw new InputError('INVALID', `quota for institution ${key} must be a non-negative integer`);
    }
    quotas[key] = q;
  }
  return { slots, capacity, quotas, agingFactor };
}

export function validateInstruction(raw, config) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InputError('INVALID', 'instruction must be an object');
  }
  const { id, institution, amount, priority, deadline } = raw;
  if (typeof id !== 'string' || id.length === 0) {
    throw new InputError('INVALID', 'instruction.id must be a non-empty string');
  }
  if (typeof institution !== 'string' || institution.length === 0) {
    throw new InputError('INVALID', `instruction ${id}: institution must be a non-empty string`, id);
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    throw new InputError('INVALID', `instruction ${id}: amount must be a non-negative finite number`, id);
  }
  if (!Number.isInteger(priority) || priority < 0) {
    throw new InputError('INVALID', `instruction ${id}: priority must be a non-negative integer`, id);
  }
  if (!Number.isInteger(deadline) || deadline < 1 || deadline > config.slots) {
    throw new InputError('INVALID', `instruction ${id}: deadline must be an integer in [1, ${config.slots}]`, id);
  }
  const age = raw.age ?? 0;
  if (!Number.isInteger(age) || age < 0) {
    throw new InputError('INVALID', `instruction ${id}: age must be a non-negative integer`, id);
  }
  const depsRaw = raw.deps ?? [];
  if (!Array.isArray(depsRaw)) {
    throw new InputError('INVALID', `instruction ${id}: deps must be an array of instruction ids`, id);
  }
  for (const dep of depsRaw) {
    if (typeof dep !== 'string' || dep.length === 0) {
      throw new InputError('INVALID', `instruction ${id}: deps entries must be non-empty strings`, id);
    }
    if (dep === id) {
      throw new InputError('CYCLE', `instruction ${id} depends on itself`, id);
    }
  }
  const deps = [...new Set(depsRaw)].sort(idCompare);
  return { id, institution, amount, priority, deadline, age, deps };
}

export function effectivePriority(inst, agingFactor) {
  return inst.priority + agingFactor * inst.age;
}

// Deterministic instruction ordering: effective priority desc, amount desc,
// deadline asc, id lexicographic asc.
export function makeOrderCompare(agingFactor) {
  return (a, b) => {
    const ea = effectivePriority(a, agingFactor);
    const eb = effectivePriority(b, agingFactor);
    if (ea !== eb) return ea > eb ? -1 : 1;
    if (a.amount !== b.amount) return a.amount > b.amount ? -1 : 1;
    if (a.deadline !== b.deadline) return a.deadline - b.deadline;
    return idCompare(a.id, b.id);
  };
}

// Kahn's algorithm with deterministic tie-breaking. Only edges whose both
// endpoints are inside the set are considered. If a cycle remains the
// returned order is shorter than the input (callers pre-filter cycles).
export function topoOrder(instructions, compare) {
  const ids = new Set(instructions.map((i) => i.id));
  const byId = new Map(instructions.map((i) => [i.id, i]));
  const indegree = new Map();
  const dependents = new Map();
  for (const inst of instructions) {
    let deg = 0;
    for (const dep of inst.deps) {
      if (!ids.has(dep)) continue;
      deg += 1;
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep).push(inst.id);
    }
    indegree.set(inst.id, deg);
  }
  const ready = instructions.filter((i) => indegree.get(i.id) === 0).sort(compare);
  const order = [];
  while (ready.length > 0) {
    const cur = ready.shift();
    order.push(cur);
    for (const depId of dependents.get(cur.id) ?? []) {
      const next = indegree.get(depId) - 1;
      indegree.set(depId, next);
      if (next === 0) ready.push(byId.get(depId));
    }
    ready.sort(compare);
  }
  return order;
}

// Total deterministic order over solutions. Lexicographic on
// (epSum, count, amountSum) then on the assignment vector keyed by id asc:
// presence beats absence, then smaller slot wins.
export function compareSolutions(a, b) {
  if (a.epSum !== b.epSum) return a.epSum > b.epSum ? -1 : 1;
  if (a.count !== b.count) return a.count > b.count ? -1 : 1;
  if (a.amountSum !== b.amountSum) return a.amountSum > b.amountSum ? -1 : 1;
  return compareAssignmentVectors(a.assignments, b.assignments);
}

export function compareAssignmentVectors(a, b) {
  const ids = [...new Set([...a.keys(), ...b.keys()])].sort(idCompare);
  for (const id of ids) {
    const inA = a.has(id);
    const inB = b.has(id);
    if (inA && !inB) return -1;
    if (!inA && inB) return 1;
    if (inA && inB) {
      const sa = a.get(id);
      const sb = b.get(id);
      if (sa !== sb) return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

export function quotaOf(quotas, institution) {
  return quotas[institution] ?? Infinity;
}

export function canonicalPairs(assignments) {
  return [...assignments.entries()].sort((a, b) => idCompare(a[0], b[0]));
}

export function hashAssignments(assignments) {
  return createHash('sha256').update(JSON.stringify(canonicalPairs(assignments))).digest('hex');
}
