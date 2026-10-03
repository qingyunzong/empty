'use strict';

const crypto = require('node:crypto');

class LineageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LineageError';
    this.code = 'LINEAGE_ERROR';
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalize(value[k]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

function deepEqual(a, b) {
  return canonicalize(a) === canonicalize(b);
}

function hashVersion(version) {
  const { hash, ...rest } = version;
  return crypto.createHash('sha256').update(canonicalize(rest)).digest('hex');
}

// Returns -1 if a happens-before b, 1 if b happens-before a,
// 0 if equal, null if concurrent.
function compareClocks(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let le = true;
  let ge = true;
  for (const k of keys) {
    const av = a[k] || 0;
    const bv = b[k] || 0;
    if (av > bv) le = false;
    if (av < bv) ge = false;
  }
  if (le && ge) return 0;
  if (le) return -1;
  if (ge) return 1;
  return null;
}

function clockDominates(higher, lower) {
  return compareClocks(lower, higher) === -1;
}

function maxClock(a, b) {
  const out = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) out[k] = Math.max(a[k] || 0, b[k] || 0);
  return out;
}

function validateVersionShape(version) {
  if (!version || typeof version !== 'object') throw new LineageError('version must be an object');
  if (typeof version.author !== 'string' || version.author.length === 0) {
    throw new LineageError('version.author must be a non-empty string');
  }
  if (!version.clock || typeof version.clock !== 'object' || Array.isArray(version.clock)) {
    throw new LineageError('version.clock must be an object mapping node ids to counters');
  }
  for (const [k, v] of Object.entries(version.clock)) {
    if (!Number.isInteger(v) || v < 0) {
      throw new LineageError(`clock entry ${k} must be a non-negative integer`);
    }
  }
  if (!Array.isArray(version.parents)) throw new LineageError('version.parents must be an array');
  if (!version.fields || typeof version.fields !== 'object' || Array.isArray(version.fields)) {
    throw new LineageError('version.fields must be an object');
  }
  if (!Array.isArray(version.evidence)) throw new LineageError('version.evidence must be an array');
}

function validateVersion(version, store) {
  validateVersionShape(version);
  const seen = new Set();
  for (const ev of version.evidence) {
    if (!ev || typeof ev.id !== 'string') throw new LineageError('evidence entries require a string id');
    if (seen.has(ev.id)) throw new LineageError(`duplicate evidence id: ${ev.id}`);
    seen.add(ev.id);
  }
  for (const parentHash of version.parents) {
    const parent = store.get(parentHash);
    if (!parent) throw new LineageError(`unknown parent reference: ${parentHash}`);
    if (!clockDominates(version.clock, parent.clock)) {
      throw new LineageError(
        `clock regression: version clock does not strictly dominate parent ${parentHash}`
      );
    }
  }
  return true;
}

function ancestorHashes(version, store) {
  const out = new Set();
  const stack = [...version.parents];
  while (stack.length > 0) {
    const h = stack.pop();
    if (out.has(h)) continue;
    out.add(h);
    const parent = store.get(h);
    if (parent) stack.push(...parent.parents);
  }
  return out;
}

// Lowest common ancestors: common ancestors that are not ancestors of
// any other common ancestor. Returns an array of versions (may be empty).
function findLcas(a, b, store) {
  const ancA = ancestorHashes(a, store);
  const ancB = ancestorHashes(b, store);
  const common = [...ancA].filter((h) => ancB.has(h));
  const lcas = common.filter((h) => {
    const hAnc = ancestorHashes(store.get(h), store);
    return !common.some((other) => other !== h && hAnc.has(other));
  });
  return lcas.map((h) => store.get(h));
}

function modifiedFields(version, baseFields) {
  const modified = new Map();
  for (const [k, v] of Object.entries(version.fields)) {
    if (!deepEqual(v, baseFields[k])) modified.set(k, v);
  }
  for (const k of Object.keys(baseFields)) {
    if (!(k in version.fields)) modified.set(k, undefined); // deleted
  }
  return modified;
}

function evidenceConflicts(evA, evB) {
  const conflicts = [];
  const byIdA = new Map(evA.map((e) => [e.id, e]));
  const byIdB = new Map(evB.map((e) => [e.id, e]));
  for (const [id, a] of byIdA) {
    const b = byIdB.get(id);
    if (b && !deepEqual(a, b)) {
      conflicts.push({
        type: 'evidence-id-mismatch',
        evidenceId: id,
        left: a,
        right: b,
      });
    }
  }
  // Mutually exclusive labels: same exclusivity group, different label.
  const groupsA = new Map();
  const groupsB = new Map();
  for (const e of evA) if (e.group) groupsA.set(e.group, e);
  for (const e of evB) if (e.group) groupsB.set(e.group, e);
  for (const [group, a] of groupsA) {
    const b = groupsB.get(group);
    if (b && a.label !== b.label) {
      conflicts.push({
        type: 'mutually-exclusive-labels',
        group,
        left: { id: a.id, label: a.label },
        right: { id: b.id, label: b.label },
      });
    }
  }
  return conflicts;
}

function mergeVersions(a, b, store) {
  const cmp = compareClocks(a.clock, b.clock);
  if (cmp === 0) return { status: 'fast-forward', version: b, reason: 'equal-clocks' };
  if (cmp === -1) return { status: 'fast-forward', version: b, reason: 'ancestor' };
  if (cmp === 1) return { status: 'fast-forward', version: a, reason: 'ancestor' };

  const lcas = findLcas(a, b, store);
  const baseFields = lcas.length > 0 ? lcas[0].fields : {};
  const modA = modifiedFields(a, baseFields);
  const modB = modifiedFields(b, baseFields);

  const conflicts = [];
  for (const [field, valueA] of modA) {
    if (!modB.has(field)) continue;
    const valueB = modB.get(field);
    if (deepEqual(valueA, valueB)) continue;
    const numeric = typeof valueA === 'number' && typeof valueB === 'number';
    conflicts.push({
      type: numeric ? 'contradictory-numeric-field' : 'contradictory-field',
      field,
      left: valueA === undefined ? null : valueA,
      right: valueB === undefined ? null : valueB,
    });
  }
  conflicts.push(...evidenceConflicts(a.evidence, b.evidence));

  if (conflicts.length > 0) {
    return {
      status: 'conflict',
      conflicts: conflicts.map((c) => ({
        ...c,
        leftVersion: a.hash || null,
        rightVersion: b.hash || null,
      })),
    };
  }

  const mergedFields = {};
  const allKeys = new Set([...Object.keys(a.fields), ...Object.keys(b.fields)]);
  for (const k of allKeys) {
    const inA = modA.has(k);
    const inB = modB.has(k);
    if (inA && inB) mergedFields[k] = modA.get(k); // equal on both sides
    else if (inA) mergedFields[k] = modA.get(k);
    else if (inB) mergedFields[k] = modB.get(k);
    else mergedFields[k] = a.fields[k];
  }
  for (const k of Object.keys(mergedFields)) {
    if (mergedFields[k] === undefined) delete mergedFields[k];
  }

  const mergedEvidence = new Map();
  for (const e of [...a.evidence, ...b.evidence]) {
    if (!mergedEvidence.has(e.id)) mergedEvidence.set(e.id, e);
  }

  const merged = {
    author: 'merge',
    clock: maxClock(a.clock, b.clock),
    parents: [a.hash, b.hash],
    fields: mergedFields,
    evidence: [...mergedEvidence.values()],
  };
  merged.hash = hashVersion(merged);
  return { status: 'merged', version: merged };
}

module.exports = {
  LineageError,
  canonicalize,
  deepEqual,
  hashVersion,
  compareClocks,
  clockDominates,
  maxClock,
  validateVersion,
  ancestorHashes,
  findLcas,
  mergeVersions,
};
