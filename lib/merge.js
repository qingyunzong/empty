'use strict';

const {
  normalizeTree,
  parsePath,
  isPrefixPath,
  deepEqual,
} = require('./tree');
const { emptyPatch, prunePatch } = require('./patch');

class MergeConflict extends Error {
  constructor(conflicts) {
    super(`merge conflict (${conflicts.length}): ${conflicts.map((c) => c.message).join('; ')}`);
    this.name = 'MergeConflict';
    this.conflicts = conflicts;
  }
}

function configOps(patch) {
  const ops = [];
  for (const path of Object.keys(patch.set || {})) ops.push({ kind: 'set', path });
  for (const path of Object.keys(patch.unset || {})) ops.push({ kind: 'unset', path });
  return ops;
}

function allOps(patch) {
  const ops = configOps(patch);
  for (const path of Object.keys(patch.addNodes || {})) ops.push({ kind: 'addNode', path });
  for (const path of patch.deleteNodes || []) ops.push({ kind: 'deleteNode', path });
  return ops;
}

function mergePatches(oursPatch, theirsPatch) {
  const ours = { ...emptyPatch(), ...normalize(oursPatch) };
  const theirs = { ...emptyPatch(), ...normalize(theirsPatch) };
  const conflicts = [];

  const oursDeletes = ours.deleteNodes;
  const theirsDeletes = theirs.deleteNodes;

  for (const deleted of oursDeletes) {
    for (const op of allOps(theirs)) {
      if (op.kind === 'deleteNode') continue;
      if (isPrefixPath(deleted, op.path)) {
        conflicts.push({
          type: 'structural',
          message: `node "${deleted}" deleted on one side but "${op.path}" ${op.kind} on the other`,
        });
      }
    }
  }
  for (const deleted of theirsDeletes) {
    for (const op of allOps(ours)) {
      if (op.kind === 'deleteNode') continue;
      if (isPrefixPath(deleted, op.path)) {
        conflicts.push({
          type: 'structural',
          message: `node "${deleted}" deleted on one side but "${op.path}" ${op.kind} on the other`,
        });
      }
    }
  }

  const mergedAdds = {};
  const addPaths = new Set([...Object.keys(ours.addNodes), ...Object.keys(theirs.addNodes)]);
  for (const path of addPaths) {
    const inOurs = ours.addNodes[path];
    const inTheirs = theirs.addNodes[path];
    if (inOurs && inTheirs) {
      if (deepEqual(inOurs, inTheirs)) {
        mergedAdds[path] = inOurs;
      } else {
        conflicts.push({
          type: 'structural',
          message: `node "${path}" added differently on both sides`,
        });
      }
    } else {
      mergedAdds[path] = inOurs || inTheirs;
    }
  }

  for (const added of Object.keys(ours.addNodes)) {
    for (const op of allOps(theirs)) {
      if (op.kind === 'addNode' && op.path === added) continue;
      if (op.path !== added && isPrefixPath(added, op.path)) {
        conflicts.push({
          type: 'structural',
          message: `node "${added}" added on one side but "${op.path}" touched on the other`,
        });
      }
    }
  }
  for (const added of Object.keys(theirs.addNodes)) {
    for (const op of allOps(ours)) {
      if (op.kind === 'addNode' && op.path === added) continue;
      if (op.path !== added && isPrefixPath(added, op.path)) {
        conflicts.push({
          type: 'structural',
          message: `node "${added}" added on one side but "${op.path}" touched on the other`,
        });
      }
    }
  }

  const mergedSet = {};
  const mergedUnset = {};
  const setPaths = new Set([...Object.keys(ours.set), ...Object.keys(theirs.set)]);
  for (const path of setPaths) {
    const oursValues = ours.set[path] || {};
    const theirsValues = theirs.set[path] || {};
    const keys = new Set([...Object.keys(oursValues), ...Object.keys(theirsValues)]);
    for (const key of keys) {
      const inOurs = key in oursValues;
      const inTheirs = key in theirsValues;
      if (inOurs && inTheirs) {
        if (deepEqual(oursValues[key], theirsValues[key])) {
          setKey(mergedSet, path, key, oursValues[key]);
        } else {
          conflicts.push({
            type: 'value',
            message: `threshold "${key}" at "${path || '/'}" set to different values`,
          });
        }
      } else {
        setKey(mergedSet, path, key, inOurs ? oursValues[key] : theirsValues[key]);
      }
    }
  }

  const unsetPaths = new Set([...Object.keys(ours.unset), ...Object.keys(theirs.unset)]);
  for (const path of unsetPaths) {
    const oursKeys = new Set(ours.unset[path] || []);
    const theirsKeys = new Set(theirs.unset[path] || []);
    for (const key of new Set([...oursKeys, ...theirsKeys])) {
      const setByOther = (oursKeys.has(key) ? theirs.set[path] : ours.set[path]) || {};
      if (key in setByOther) {
        conflicts.push({
          type: 'value',
          message: `threshold "${key}" at "${path || '/'}" unset on one side but set on the other`,
        });
        continue;
      }
      if (!mergedUnset[path]) mergedUnset[path] = [];
      mergedUnset[path].push(key);
    }
  }

  for (const [path, keys] of Object.entries(mergedUnset)) {
    keys.sort();
  }

  const mergedDeletes = [];
  const allDeletes = [...new Set([...oursDeletes, ...theirsDeletes])].sort();
  for (const path of allDeletes) {
    const subsumed = allDeletes.some((other) => other !== path && isPrefixPath(other, path));
    if (!subsumed) mergedDeletes.push(path);
  }

  if (conflicts.length > 0) throw new MergeConflict(conflicts);

  return prunePatch({
    set: mergedSet,
    unset: mergedUnset,
    addNodes: mergedAdds,
    deleteNodes: mergedDeletes,
  });
}

function setKey(target, path, key, value) {
  if (!target[path]) target[path] = {};
  target[path][key] = value;
}

function normalize(patch) {
  const source = patch || {};
  return {
    set: source.set || {},
    unset: source.unset || {},
    addNodes: source.addNodes || {},
    deleteNodes: source.deleteNodes || [],
  };
}

function mergeTrees(baseTree, oursTree, theirsTree, diffTrees, applyPatch) {
  const base = normalizeTree(baseTree);
  const oursDiff = diffTrees(base, oursTree);
  const theirsDiff = diffTrees(base, theirsTree);
  const merged = mergePatches(oursDiff, theirsDiff);
  return { patch: merged, tree: applyPatch(base, merged) };
}

module.exports = { MergeConflict, mergePatches, mergeTrees };
