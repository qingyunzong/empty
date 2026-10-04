import { deepEq } from './util.js';
import { err } from './errors.js';

// Three-valued row state per key:
//   { tag: 'asserted', value } | { tag: 'retracted' } | absent (unknown)
// "unknown" is a first-class value in merges, never a failure.

export const UNKNOWN = Object.freeze({ tag: 'unknown' });

const at = (state, key) => state[key] ?? UNKNOWN;

export function validateOps(ops) {
  if (!Array.isArray(ops)) throw err('E_INVALID', 'batch.ops must be an array');
  for (const op of ops) {
    if (!op || typeof op !== 'object') throw err('E_INVALID', 'op must be an object');
    if (op.op !== 'assert' && op.op !== 'retract')
      throw err('E_INVALID', `unknown op ${JSON.stringify(op.op)}`);
    if (typeof op.key !== 'string' || op.key.length === 0)
      throw err('E_INVALID', 'op.key must be a non-empty string');
  }
}

export function applyOps(state, ops) {
  const next = { ...state };
  for (const op of ops) {
    if (op.op === 'assert') next[op.key] = { tag: 'asserted', value: op.value ?? null };
    else next[op.key] = { tag: 'retracted' };
  }
  return next;
}

// Row-level certificate delta of `to` relative to `from`.
export function diffStates(from, to) {
  const adds = {};
  const dels = [];
  for (const [k, cell] of Object.entries(to)) {
    if (cell.tag === 'asserted' && !deepEq(from[k] ?? UNKNOWN, cell)) adds[k] = cell.value;
  }
  for (const [k, cell] of Object.entries(from)) {
    if (cell.tag === 'asserted' && (to[k] ?? UNKNOWN).tag !== 'asserted') dels.push(k);
  }
  dels.sort();
  return { adds, dels };
}

// Three-way merge of row states. Unknown (absent) entries participate as a
// value; a key only conflicts when all three of base/left/right disagree.
export function merge3(base, left, right) {
  const state = {};
  const conflicts = [];
  const keys = new Set([...Object.keys(base), ...Object.keys(left), ...Object.keys(right)]);
  for (const k of [...keys].sort()) {
    const b = at(base, k);
    const l = at(left, k);
    const r = at(right, k);
    let res;
    if (deepEq(l, r)) res = l;
    else if (deepEq(l, b)) res = r;
    else if (deepEq(r, b)) res = l;
    else {
      conflicts.push({ key: k, base: b, left: l, right: r });
      continue;
    }
    if (res.tag !== 'unknown') state[k] = res;
  }
  return { state, conflicts };
}

// Per-batch key effects (last write wins inside a batch).
export function effectsOf(batch) {
  const eff = {};
  for (const op of batch.ops) {
    eff[op.key] = op.op === 'assert' ? { tag: 'asserted', value: op.value ?? null } : { tag: 'retracted' };
  }
  return eff;
}
