import { isDeepStrictEqual } from 'node:util';

export const ABSENT = Symbol('absent');

function slot(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : ABSENT;
}

function reportValue(value) {
  return value === ABSENT ? null : value;
}

export function mergeField(base, left, right) {
  const leftChanged = !isDeepStrictEqual(left, base);
  const rightChanged = !isDeepStrictEqual(right, base);

  if (!leftChanged && !rightChanged) return { status: 'clean', value: base };
  if (leftChanged && !rightChanged) return { status: 'clean', value: left };
  if (!leftChanged && rightChanged) return { status: 'clean', value: right };
  if (isDeepStrictEqual(left, right)) return { status: 'clean', value: left };

  let type = 'both-modified';
  if (base === ABSENT) type = 'both-added';
  else if (left === ABSENT || right === ABSENT) type = 'modify-delete';

  return { status: 'conflict', type, base, left, right };
}

function mergeRecord(id, base, left, right, conflicts) {
  const inBase = base !== ABSENT;
  const inLeft = left !== ABSENT;
  const inRight = right !== ABSENT;

  if (!inBase) {
    if (!inLeft && !inRight) return ABSENT;
    if (inLeft && !inRight) return left;
    if (!inLeft && inRight) return right;
    if (isDeepStrictEqual(left, right)) return left;
    conflicts.push({ id, type: 'both-added', base: null, left, right });
    return ABSENT;
  }

  if (!inLeft && !inRight) return ABSENT;

  if (!inLeft) {
    if (isDeepStrictEqual(right, base)) return ABSENT;
    conflicts.push({ id, type: 'modify-delete', base, left: null, right });
    return ABSENT;
  }

  if (!inRight) {
    if (isDeepStrictEqual(left, base)) return ABSENT;
    conflicts.push({ id, type: 'modify-delete', base, left, right: null });
    return ABSENT;
  }

  const merged = {};
  const fields = new Set([
    ...Object.keys(base),
    ...Object.keys(left),
    ...Object.keys(right),
  ]);
  for (const field of fields) {
    const result = mergeField(slot(base, field), slot(left, field), slot(right, field));
    if (result.status === 'conflict') {
      conflicts.push({
        id,
        field,
        type: result.type,
        base: reportValue(result.base),
        left: reportValue(result.left),
        right: reportValue(result.right),
      });
    } else if (result.value !== ABSENT) {
      merged[field] = result.value;
    }
  }
  return merged;
}

export function mergeDatasets(base, left, right) {
  const merged = {};
  const conflicts = [];
  const ids = new Set([
    ...Object.keys(base),
    ...Object.keys(left),
    ...Object.keys(right),
  ]);
  for (const id of ids) {
    const result = mergeRecord(id, slot(base, id), slot(left, id), slot(right, id), conflicts);
    if (result !== ABSENT) merged[id] = result;
  }
  return { merged, conflicts };
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}
