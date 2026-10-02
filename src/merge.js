import { createHash } from 'node:crypto';
import { compareClocks } from './vector-clock.js';

export const FIELDS = ['value', 'quality', 'reviewed'];

export const REASONS = {
  IDENTICAL: 'identical-change',
  ONLY_A: 'only-a-changed',
  ONLY_B: 'only-b-changed',
  UNCHANGED: 'unchanged',
  LEVEL: 'higher-source-level',
  TIMESTAMP: 'newer-timestamp',
  AUTHOR: 'author-lexicographic',
  CONFLICT_EQUAL_TIME: 'equal-timestamp',
  CONFLICT_REVIEWED: 'reviewed-divergent-booleans',
  CONFLICT_STALE: 'stale-old-value',
  CONFLICT_UNDECIDABLE: 'undecidable',
};

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function valuesEqual(x, y) {
  return stableStringify(x) === stableStringify(y);
}

export function makeCertificate(field, baseValue, changeA, changeB, reason) {
  const payload = {
    field,
    reason,
    baseValue: baseValue ?? null,
    a: changeA ?? null,
    b: changeB ?? null,
  };
  const hash = createHash('sha256').update(stableStringify(payload)).digest('hex');
  return { ...payload, sha256: hash };
}

// Decide a single field. changeA/changeB are null when that side did not
// touch the field, otherwise { old, new, author, sourceLevel, vectorClock }.
export function decideField(field, baseValue, changeA, changeB) {
  if (!changeA && !changeB) {
    return { decision: 'base', value: baseValue, reason: REASONS.UNCHANGED };
  }
  if (changeA && !changeB) {
    if (!valuesEqual(changeA.old, baseValue)) {
      return conflictResult(field, baseValue, changeA, changeB, REASONS.CONFLICT_STALE);
    }
    return { decision: 'a', value: changeA.new, reason: REASONS.ONLY_A };
  }
  if (!changeA && changeB) {
    if (!valuesEqual(changeB.old, baseValue)) {
      return conflictResult(field, baseValue, changeA, changeB, REASONS.CONFLICT_STALE);
    }
    return { decision: 'b', value: changeB.new, reason: REASONS.ONLY_B };
  }

  // Both sides changed the field.
  if (valuesEqual(changeA.new, changeB.new)) {
    return { decision: 'a', value: changeA.new, reason: REASONS.IDENTICAL };
  }

  if (
    field === 'reviewed' &&
    typeof changeA.new === 'boolean' &&
    typeof changeB.new === 'boolean'
  ) {
    // Both sides set reviewed to different booleans: never auto-decidable.
    return conflictResult(field, baseValue, changeA, changeB, REASONS.CONFLICT_REVIEWED);
  }

  if (!valuesEqual(changeA.old, baseValue) || !valuesEqual(changeB.old, baseValue)) {
    return conflictResult(field, baseValue, changeA, changeB, REASONS.CONFLICT_STALE);
  }

  if (changeA.sourceLevel !== changeB.sourceLevel) {
    const winner = changeA.sourceLevel > changeB.sourceLevel ? 'a' : 'b';
    const change = winner === 'a' ? changeA : changeB;
    return { decision: winner, value: change.new, reason: REASONS.LEVEL };
  }

  const order = compareClocks(changeA.vectorClock, changeB.vectorClock);
  if (order === 'equal') {
    return conflictResult(field, baseValue, changeA, changeB, REASONS.CONFLICT_EQUAL_TIME);
  }
  if (order === 'a-after-b') {
    return { decision: 'a', value: changeA.new, reason: REASONS.TIMESTAMP };
  }
  if (order === 'b-after-a') {
    return { decision: 'b', value: changeB.new, reason: REASONS.TIMESTAMP };
  }

  // Concurrent clocks: deterministic tiebreak by author lexicographic order.
  if (changeA.author !== changeB.author) {
    const winner = changeA.author < changeB.author ? 'a' : 'b';
    const change = winner === 'a' ? changeA : changeB;
    return { decision: winner, value: change.new, reason: REASONS.AUTHOR };
  }
  return conflictResult(field, baseValue, changeA, changeB, REASONS.CONFLICT_UNDECIDABLE);
}

function conflictResult(field, baseValue, changeA, changeB, reason) {
  return {
    decision: 'conflict',
    reason,
    certificate: makeCertificate(field, baseValue, changeA, changeB, reason),
  };
}

function attachMeta(change, branch) {
  if (!change) return null;
  return {
    old: change.old,
    new: change.new,
    author: branch.author,
    sourceLevel: branch.sourceLevel,
    vectorClock: branch.vectorClock,
  };
}

// Three-way merge of one base record and two branches.
// branch: { author, sourceLevel, vectorClock, changes: { [field]: { old, new } } }
export function mergeBranches({ base, branchA, branchB }) {
  const merged = { ...base };
  const decisions = [];
  const conflicts = [];

  for (const field of FIELDS) {
    const changeA = attachMeta(branchA.changes?.[field], branchA);
    const changeB = attachMeta(branchB.changes?.[field], branchB);
    const result = decideField(field, base[field], changeA, changeB);
    const entry = { field, decision: result.decision, reason: result.reason };
    if (result.decision === 'conflict') {
      entry.certificate = result.certificate;
      conflicts.push(result.certificate);
    } else {
      entry.value = result.value;
      merged[field] = result.value;
    }
    decisions.push(entry);
  }

  return {
    status: conflicts.length > 0 ? 'conflict' : 'merged',
    merged: conflicts.length > 0 ? null : merged,
    decisions,
    conflicts,
  };
}
