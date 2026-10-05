'use strict';

const {
  normalizePatch,
  PatchBuilder,
  applyToBuilder,
  isPrefixPath,
  canonical,
} = require('./tree');

class ConflictError extends Error {
  constructor(conflicts) {
    super('merge conflict: ' + conflicts.map((c) => c.detail).join('; '));
    this.name = 'ConflictError';
    this.code = 'CONFLICT';
    this.conflicts = conflicts;
  }
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// Three-way merge of two patches relative to a common base state.
// Returns { patch, conflicts }; patch is null when conflicts exist.
function mergePatches(left, right) {
  const l = normalizePatch(left);
  const r = normalizePatch(right);
  const conflicts = [];

  // Structural: one side deletes a node, the other modifies config in its subtree.
  const rightModified = [...Object.keys(r.set), ...Object.keys(r.unset)];
  const leftModified = [...Object.keys(l.set), ...Object.keys(l.unset)];
  for (const d of l.delete) {
    for (const p of rightModified) {
      if (p === d || isPrefixPath(d, p)) {
        conflicts.push({
          type: 'structural',
          path: p,
          detail: `left deletes node ${d} but right modifies config at ${p}`,
        });
      }
    }
  }
  for (const d of r.delete) {
    for (const p of leftModified) {
      if (p === d || isPrefixPath(d, p)) {
        conflicts.push({
          type: 'structural',
          path: p,
          detail: `right deletes node ${d} but left modifies config at ${p}`,
        });
      }
    }
  }

  // Value: same path + same override key changed on both sides.
  const opOf = (patch, path, key) => {
    const set = patch.set[path];
    if (set && hasOwn(set, key)) return { kind: 'set', value: set[key] };
    if ((patch.unset[path] || []).includes(key)) return { kind: 'unset' };
    return null;
  };
  const paths = new Set([
    ...Object.keys(l.set), ...Object.keys(l.unset),
    ...Object.keys(r.set), ...Object.keys(r.unset),
  ]);
  for (const path of paths) {
    const keys = new Set([
      ...Object.keys(l.set[path] || {}), ...(l.unset[path] || []),
      ...Object.keys(r.set[path] || {}), ...(r.unset[path] || []),
    ]);
    for (const key of keys) {
      const lo = opOf(l, path, key);
      const ro = opOf(r, path, key);
      if (!lo || !ro) continue;
      if (lo.kind === 'set' && ro.kind === 'set' && canonical(lo.value) === canonical(ro.value)) {
        continue; // identical change on both sides: dedupe
      }
      conflicts.push({
        type: 'value',
        path,
        key,
        detail: `conflicting override for ${path} key ${key}: ` +
          `${lo.kind === 'set' ? canonical(lo.value) : 'unset'} vs ` +
          `${ro.kind === 'set' ? canonical(ro.value) : 'unset'}`,
      });
    }
  }

  if (conflicts.length > 0) return { patch: null, conflicts };

  const builder = new PatchBuilder();
  applyToBuilder(builder, l);
  applyToBuilder(builder, r);
  return { patch: builder.toPatch(), conflicts: [] };
}

module.exports = { ConflictError, mergePatches };
