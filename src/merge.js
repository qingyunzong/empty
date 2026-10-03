'use strict';

const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { compareClocks } = require('./vector-clock');

const FIELDS = ['value', 'quality', 'reviewed'];

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function fingerprint(payload) {
  return createHash('sha256').update(canonical(payload)).digest('hex');
}

/**
 * Fold one branch's edit list into per-field effective state.
 * An edit whose `old` does not match the running value is a stale write:
 * the field's remaining edits on that branch are discarded.
 */
function foldBranch(base, edits) {
  const byField = new Map();
  for (const edit of edits || []) {
    if (!byField.has(edit.field)) byField.set(edit.field, []);
    byField.get(edit.field).push(edit);
  }
  const state = new Map();
  for (const field of FIELDS) {
    const list = byField.get(field) || [];
    let current = base[field];
    let stale = false;
    let staleEdit = null;
    let lastEdit = null;
    for (const edit of list) {
      if (!stale && !isDeepStrictEqual(edit.old, current)) {
        stale = true;
        staleEdit = edit;
      }
      if (!stale) {
        current = edit.new;
        lastEdit = edit;
      }
    }
    state.set(field, {
      changed: lastEdit !== null,
      stale,
      staleEdit,
      value: lastEdit ? lastEdit.new : base[field],
      edit: lastEdit,
    });
  }
  return state;
}

function editSummary(edit) {
  if (!edit) return null;
  return {
    author: edit.author,
    level: edit.level,
    clock: edit.clock,
    old: edit.old,
    new: edit.new,
  };
}

function makeConflict(field, reason, base, left, right) {
  const cert = {
    type: 'merge-conflict',
    field,
    reason,
    base: base[field],
    left: editSummary(left.edit),
    right: editSummary(right.edit),
  };
  cert.certificateId = fingerprint(cert);
  return cert;
}

/**
 * Deterministic auto policy: source level, then vector timestamp,
 * then author lexicographic order (for concurrent clocks).
 * Returns 'left' or 'right'.
 */
function decideByPolicy(leftEdit, rightEdit) {
  if (leftEdit.level !== rightEdit.level) {
    return leftEdit.level > rightEdit.level ? 'left' : 'right';
  }
  const order = compareClocks(leftEdit.clock, rightEdit.clock);
  if (order === 'gt') return 'left';
  if (order === 'lt') return 'right';
  if (order === 'concurrent') {
    return String(leftEdit.author) <= String(rightEdit.author) ? 'left' : 'right';
  }
  return null; // identical clocks: cannot auto-decide
}

function mergeField(field, base, left, right) {
  if (!left.changed && !right.changed) {
    return { value: base[field], resolution: 'base', reason: 'neither branch changed the field' };
  }
  if (left.stale && right.stale) {
    return { value: base[field], resolution: 'base', reason: 'both branches wrote stale values; kept base' };
  }
  if (left.stale) {
    return { value: right.value, resolution: 'right', reason: 'left edit old value mismatches base (stale write)' };
  }
  if (right.stale) {
    return { value: left.value, resolution: 'left', reason: 'right edit old value mismatches base (stale write)' };
  }
  if (!left.changed) {
    return { value: right.value, resolution: 'right', reason: 'only right changed the field' };
  }
  if (!right.changed) {
    return { value: left.value, resolution: 'left', reason: 'only left changed the field' };
  }
  if (isDeepStrictEqual(left.value, right.value)) {
    return { value: left.value, resolution: 'both', reason: 'both branches made the identical change' };
  }
  if (
    field === 'reviewed' &&
    typeof left.value === 'boolean' &&
    typeof right.value === 'boolean' &&
    left.value !== right.value
  ) {
    return { conflict: makeConflict(field, 'reviewed-divergence', base, left, right) };
  }
  const winner = decideByPolicy(left.edit, right.edit);
  if (winner === null) {
    return { conflict: makeConflict(field, 'same-timestamp', base, left, right) };
  }
  const chosen = winner === 'left' ? left : right;
  let reason;
  if (left.edit.level !== right.edit.level) {
    reason = `higher source level wins (level ${chosen.edit.level})`;
  } else if (compareClocks(left.edit.clock, right.edit.clock) !== 'concurrent') {
    reason = 'same level, newer vector timestamp wins';
  } else {
    reason = `concurrent clocks, author lexicographic order wins (${chosen.edit.author})`;
  }
  return { value: chosen.value, resolution: winner, reason };
}

/**
 * Three-way field-level merge.
 * base: { value, quality, reviewed }
 * leftEdits / rightEdits: arrays of { author, level, clock, field, old, new }
 * Returns { merged, decisions, conflicts }.
 */
function mergeRecords(base, leftEdits, rightEdits) {
  return mergeWithEdits(base, leftEdits, rightEdits);
}

function mergeWithEdits(base, leftEdits, rightEdits) {
  const left = foldBranch(base, leftEdits);
  const right = foldBranch(base, rightEdits);
  const merged = {};
  const decisions = [];
  const conflicts = [];
  for (const field of FIELDS) {
    const outcome = mergeField(field, base, left.get(field), right.get(field));
    const entry = {
      field,
      base: base[field],
      left: left.get(field).changed ? left.get(field).value : undefined,
      right: right.get(field).changed ? right.get(field).value : undefined,
      leftStale: left.get(field).stale,
      rightStale: right.get(field).stale,
    };
    if (outcome.conflict) {
      conflicts.push(outcome.conflict);
      decisions.push({ ...entry, resolution: 'conflict', reason: outcome.conflict.reason });
    } else {
      merged[field] = outcome.value;
      decisions.push({ ...entry, merged: outcome.value, resolution: outcome.resolution, reason: outcome.reason });
    }
  }
  return { merged, decisions, conflicts };
}

module.exports = { mergeRecords: mergeWithEdits, mergeWithEdits, foldBranch, decideByPolicy, compareClocks, FIELDS };
