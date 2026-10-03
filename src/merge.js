import { deepEqual } from './canonical.js';

/**
 * Conflict types:
 *  - both-modified:          same field changed to different values on both sides
 *  - both-added:             same field/record added on both sides with different values
 *  - modified-vs-deleted:    one side changed the field/record, the other deleted it
 */

/** Sentinel for "field/record not present". Exported for tests and callers. */
export const ABSENT = Symbol('absent');

function get(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : ABSENT;
}

function classifyFieldConflict(base, left, right) {
  if (base === ABSENT) return 'both-added';
  if (left === ABSENT || right === ABSENT) return 'modified-vs-deleted';
  return 'both-modified';
}

function expose(v) {
  return v === ABSENT ? null : v;
}

/**
 * Merge one field given the three versions (ABSENT sentinel allowed).
 * Returns { value } on clean merge (value may be ABSENT = deleted),
 * or { conflict } describing the clash.
 */
export function mergeField(base, left, right) {
  const leftChanged = left === ABSENT ? base !== ABSENT : base === ABSENT || !deepEqual(base, left);
  const rightChanged = right === ABSENT ? base !== ABSENT : base === ABSENT || !deepEqual(base, right);

  if (!leftChanged && !rightChanged) return { value: base };
  if (leftChanged && !rightChanged) return { value: left };
  if (rightChanged && !leftChanged) return { value: right };

  // Both sides changed the field.
  if (left === ABSENT && right === ABSENT) return { value: ABSENT }; // both deleted
  if (left !== ABSENT && right !== ABSENT && deepEqual(left, right)) {
    return { value: left }; // identical modification
  }
  return {
    conflict: {
      type: classifyFieldConflict(base, left, right),
      base: expose(base),
      left: expose(left),
      right: expose(right),
    },
  };
}

/**
 * Merge one record (object of fields) present in base and both sides.
 * Returns { record } or pushes field conflicts into `conflicts`.
 */
function mergeRecordFields(id, baseRec, leftRec, rightRec, conflicts) {
  const fields = new Set([
    ...Object.keys(baseRec),
    ...Object.keys(leftRec),
    ...Object.keys(rightRec),
  ]);
  const record = {};
  let ok = true;
  for (const field of [...fields].sort()) {
    const res = mergeField(get(baseRec, field), get(leftRec, field), get(rightRec, field));
    if (res.conflict) {
      ok = false;
      conflicts.push({ id, field, ...res.conflict });
    } else if (res.value !== ABSENT) {
      record[field] = res.value;
    }
  }
  return ok ? { record } : { partial: record };
}

/**
 * Three-way merge of datasets shaped as { [id]: { field: value, ... } }.
 * Returns { merged, conflicts, stats }.
 * `merged` is complete only when `conflicts` is empty; callers must not
 * emit a partial merge when conflicts exist.
 */
export function mergeDatasets(base, left, right) {
  for (const [name, ds] of [['base', base], ['left', left], ['right', right]]) {
    if (ds === null || typeof ds !== 'object' || Array.isArray(ds)) {
      throw new TypeError(`${name} dataset must be a JSON object keyed by record id`);
    }
  }

  const conflicts = [];
  const merged = {};
  const ids = new Set([...Object.keys(base), ...Object.keys(left), ...Object.keys(right)]);

  for (const id of [...ids].sort()) {
    const b = get(base, id);
    const l = get(left, id);
    const r = get(right, id);

    if (b === ABSENT) {
      // Record not in baseline: added on one or both sides.
      if (l === ABSENT && r === ABSENT) continue; // unreachable, kept for clarity
      if (l === ABSENT) { merged[id] = r; continue; }
      if (r === ABSENT) { merged[id] = l; continue; }
      if (deepEqual(l, r)) { merged[id] = l; continue; }
      conflicts.push({
        id,
        field: null,
        type: 'both-added',
        base: null,
        left: l,
        right: r,
      });
      continue;
    }

    // Record exists in baseline.
    if (l === ABSENT && r === ABSENT) continue; // deleted on both sides
    if (l === ABSENT || r === ABSENT) {
      const kept = l === ABSENT ? r : l;
      if (deepEqual(b, kept)) continue; // deleted on one side, untouched on the other
      conflicts.push({
        id,
        field: null,
        type: 'modified-vs-deleted',
        base: b,
        left: l === ABSENT ? null : l,
        right: r === ABSENT ? null : r,
      });
      continue;
    }

    const res = mergeRecordFields(id, b, l, r, conflicts);
    if (res.record) merged[id] = res.record;
  }

  const stats = {
    records: Object.keys(merged).length,
    conflicts: conflicts.length,
  };
  return { merged, conflicts, stats };
}
