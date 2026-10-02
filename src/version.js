import { increment, mergeClocks, compare } from './vectorClock.js';
import { contentHash } from './stableJson.js';
import { historyConflict, badInput } from './errors.js';

function versionId(parents, clock, data) {
  return contentHash({ parents: [...parents].sort(), clock, data }).slice(0, 16);
}

export function createBaseVersion(data, node = 'node0') {
  const clock = increment({}, node);
  const version = {
    id: null,
    clock,
    parents: [],
    data: { ...data },
    ops: [],
  };
  version.id = versionId(version.parents, version.clock, version.data);
  return version;
}

// Apply a repair plan: produces a NEW causal successor version.
// The child's vector clock strictly dominates the parent's clock.
export function applyRepair(parentVersion, plan, node) {
  const data = { ...parentVersion.data };
  const ops = [];
  for (const change of [...plan.changes].sort((a, b) => (a.var < b.var ? -1 : 1))) {
    data[change.var] = change.to;
    ops.push({ var: change.var, from: change.from, to: change.to, cost: change.cost });
  }
  const clock = increment(parentVersion.clock, node);
  const version = {
    id: null,
    clock,
    parents: [parentVersion.id],
    data,
    ops,
    cost: plan.cost,
    planHash: plan.hash,
  };
  version.id = versionId(version.parents, version.clock, version.data);
  return version;
}

function diffData(base, other) {
  const delta = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(other)]);
  for (const k of keys) {
    if (base[k] !== other[k]) delta[k] = other[k];
  }
  return delta;
}

// Merge two versions given their common ancestor `base`.
// - If one clock dominates, the dominant version is returned (fast-forward).
// - If concurrent, both deltas are applied to base; disjoint changes commute.
// - Same variable changed to different values => HISTORY_CONFLICT.
// merge(base, a, b) and merge(base, b, a) produce identical versions.
export function mergeVersions(base, a, b, node = 'merge') {
  if (!base || !a || !b) throw badInput('merge requires base, a and b versions');
  const rel = compare(a.clock, b.clock);
  if (rel === 'eq') return { version: a, relation: 'equal' };
  if (rel === 'gt') return { version: a, relation: 'fast-forward' };
  if (rel === 'lt') return { version: b, relation: 'fast-forward' };

  const deltaA = diffData(base.data, a.data);
  const deltaB = diffData(base.data, b.data);
  const conflicts = [];
  for (const key of Object.keys(deltaA)) {
    if (key in deltaB && deltaA[key] !== deltaB[key]) {
      conflicts.push({ var: key, a: deltaA[key], b: deltaB[key], base: base.data[key] });
    }
  }
  if (conflicts.length > 0) throw historyConflict(conflicts);

  // Deterministic application order independent of argument order:
  // sort branches by version id, then apply each branch's ops sorted by var.
  const branches = [
    { id: a.id, delta: deltaA },
    { id: b.id, delta: deltaB },
  ].sort((x, y) => (x.id < y.id ? -1 : 1));
  const data = { ...base.data };
  const ops = [];
  for (const branch of branches) {
    for (const key of Object.keys(branch.delta).sort()) {
      ops.push({ var: key, from: base.data[key], to: branch.delta[key], source: branch.id });
      data[key] = branch.delta[key];
    }
  }
  const clock = increment(mergeClocks(a.clock, b.clock), node);
  const parents = [a.id, b.id].sort();
  const version = { id: null, clock, parents, data, ops, merged: true };
  version.id = versionId(version.parents, version.clock, version.data);
  return { version, relation: 'merged' };
}
