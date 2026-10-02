'use strict';

const { isDeepStrictEqual } = require('node:util');
const vclock = require('./vclock');
const { computeHash } = require('./version');

const DEFAULT_EXCLUSIVE_GROUPS = [
  ['positive', 'negative'],
  ['accepted', 'rejected'],
  ['control', 'treatment'],
];

function labelsExclusive(labelA, labelB, groups) {
  if (labelA === undefined || labelB === undefined || labelA === labelB) return false;
  return groups.some((group) => group.includes(labelA) && group.includes(labelB));
}

function mergeResults(a, b, conflicts) {
  const merged = {};
  const fields = [...new Set([...Object.keys(a.results), ...Object.keys(b.results)])].sort();
  for (const field of fields) {
    const inA = Object.prototype.hasOwnProperty.call(a.results, field);
    const inB = Object.prototype.hasOwnProperty.call(b.results, field);
    if (inA && !inB) {
      merged[field] = a.results[field];
    } else if (inB && !inA) {
      merged[field] = b.results[field];
    } else if (isDeepStrictEqual(a.results[field], b.results[field])) {
      merged[field] = a.results[field];
    } else if (typeof a.results[field] === 'number' && typeof b.results[field] === 'number') {
      conflicts.push({
        kind: 'numeric-contradiction',
        field,
        valueA: a.results[field],
        valueB: b.results[field],
      });
    } else {
      conflicts.push({
        kind: 'value-mismatch',
        field,
        valueA: a.results[field],
        valueB: b.results[field],
      });
    }
  }
  return merged;
}

function mergeEvidence(a, b, exclusiveGroups, conflicts) {
  const byId = new Map();
  for (const item of a.evidence) byId.set(item.id, item);
  for (const item of b.evidence) {
    if (byId.has(item.id)) {
      if (!isDeepStrictEqual(byId.get(item.id), item)) {
        conflicts.push({
          kind: 'evidence-mismatch',
          evidenceId: item.id,
          evidenceA: byId.get(item.id),
          evidenceB: item,
        });
      }
    } else {
      byId.set(item.id, item);
    }
  }
  for (const ea of a.evidence) {
    for (const eb of b.evidence) {
      if (ea.id === eb.id) continue;
      if (labelsExclusive(ea.label, eb.label, exclusiveGroups)) {
        conflicts.push({
          kind: 'exclusive-evidence',
          labels: [ea.label, eb.label],
          evidenceA: ea.id,
          evidenceB: eb.id,
        });
      }
    }
  }
  return [...byId.values()].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

// mergeVersions(store, hashA, hashB, options)
//  -> { status: 'up-to-date' | 'fast-forward', head }
//  -> { status: 'merged', head }              (new commit persisted in store)
//  -> { status: 'conflict', conflicts, versions }  (no commit created)
function mergeVersions(store, hashA, hashB, options = {}) {
  const a = store.get(hashA);
  const b = store.get(hashB);
  const cmp = vclock.compare(a.clock, b.clock);

  if (cmp === vclock.EQUAL) {
    if (a.hash === b.hash) return { status: 'up-to-date', head: a };
    return {
      status: 'conflict',
      versions: [hashA, hashB],
      conflicts: [{
        kind: 'divergent-equal-clock',
        message: 'identical vector clocks but different lineage hashes',
      }],
    };
  }
  if (cmp === vclock.LESS) return { status: 'fast-forward', head: b };
  if (cmp === vclock.GREATER) return { status: 'fast-forward', head: a };

  const exclusiveGroups = options.exclusiveGroups || DEFAULT_EXCLUSIVE_GROUPS;
  const conflicts = [];
  const results = mergeResults(a, b, conflicts);
  const evidence = mergeEvidence(a, b, exclusiveGroups, conflicts);

  if (conflicts.length > 0) {
    return { status: 'conflict', versions: [hashA, hashB], conflicts };
  }

  const merged = {
    author: options.author || `merge(${a.author},${b.author})`,
    clock: vclock.mergeClocks(a.clock, b.clock),
    parents: [hashA, hashB].sort(),
    results,
    evidence,
  };
  const hash = store.put(merged);
  return { status: 'merged', head: store.get(hash) };
}

module.exports = { mergeVersions, DEFAULT_EXCLUSIVE_GROUPS, labelsExclusive };
