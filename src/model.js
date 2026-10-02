import { createHash } from 'node:crypto';

export class ModelError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ModelError';
    this.code = code;
    this.details = details;
  }
}

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

export function hash(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

// Three-valued row state:
//   undefined  -> unknown (never observed; a legitimate value, never a failure)
//   {t:'a',v}  -> asserted with value v
//   {t:'r'}    -> retracted
export function triEqual(x, y) {
  if (x === undefined || y === undefined) return x === y;
  if (x.t !== y.t) return false;
  if (x.t === 'r') return true;
  return canonical(x.v) === canonical(y.v);
}

export function validateOps(ops) {
  if (!Array.isArray(ops)) throw new ModelError('E_BAD_BATCH', 'ops must be an array');
  for (const op of ops) {
    if (!op || typeof op.key !== 'string' || (op.op !== 'assert' && op.op !== 'retract')) {
      throw new ModelError('E_BAD_BATCH', `invalid op ${JSON.stringify(op)}`);
    }
  }
}

// Applies ops in order to state (Map key -> tri). Returns row-level changes:
// [{key, before, after}] where before/after are tri values or null for unknown.
export function applyOps(state, ops) {
  validateOps(ops);
  const changes = [];
  for (const op of ops) {
    const before = state.get(op.key);
    const after = op.op === 'assert' ? { t: 'a', v: op.value ?? null } : { t: 'r' };
    if (!triEqual(before, after)) {
      state.set(op.key, after);
      changes.push({ key: op.key, before: before ?? null, after });
    }
  }
  return changes;
}

export function applyChanges(state, changes) {
  for (const c of changes) {
    if (c.after === null || c.after === undefined) state.delete(c.key);
    else state.set(c.key, c.after);
  }
}

export function diffStates(from, to) {
  const keys = [...new Set([...from.keys(), ...to.keys()])].sort();
  const changes = [];
  for (const key of keys) {
    const a = from.get(key);
    const b = to.get(key);
    if (!triEqual(a, b)) changes.push({ key, before: a ?? null, after: b ?? null });
  }
  return changes;
}

// Three-way three-valued merge. unknown participates as a regular value:
// a key unknown in both branches since base merges to unknown without conflict.
export function mergeStates(base, a, b) {
  const keys = [...new Set([...base.keys(), ...a.keys(), ...b.keys()])].sort();
  const state = new Map();
  const conflicts = [];
  for (const key of keys) {
    const bv = base.get(key);
    const av = a.get(key);
    const bw = b.get(key);
    if (triEqual(av, bw)) {
      if (av !== undefined) state.set(key, av);
    } else if (triEqual(av, bv)) {
      if (bw !== undefined) state.set(key, bw);
    } else if (triEqual(bw, bv)) {
      if (av !== undefined) state.set(key, av);
    } else {
      conflicts.push({ key, base: bv ?? null, a: av ?? null, b: bw ?? null });
    }
  }
  return { state, conflicts };
}
