'use strict';

const {
  normalizeTree,
  parsePath,
  joinPath,
  pathDepth,
  getNode,
  deepEqual,
} = require('./tree');

class PatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PatchError';
  }
}

function emptyPatch() {
  return { set: {}, unset: {}, addNodes: {}, deleteNodes: [] };
}

function normalizePatch(patch) {
  const source = patch || {};
  return {
    set: source.set || {},
    unset: source.unset || {},
    addNodes: source.addNodes || {},
    deleteNodes: source.deleteNodes || [],
  };
}

function isEmptyPatch(patch) {
  const p = normalizePatch(patch);
  return (
    Object.keys(p.set).length === 0 &&
    Object.keys(p.unset).length === 0 &&
    Object.keys(p.addNodes).length === 0 &&
    p.deleteNodes.length === 0
  );
}

function prunePatch(patch) {
  const p = normalizePatch(patch);
  const out = {};
  if (Object.keys(p.set).length > 0) out.set = p.set;
  if (Object.keys(p.unset).length > 0) out.unset = p.unset;
  if (Object.keys(p.addNodes).length > 0) out.addNodes = p.addNodes;
  if (p.deleteNodes.length > 0) out.deleteNodes = p.deleteNodes;
  return out;
}

function applyPatch(tree, patch) {
  const root = normalizeTree(tree);
  const p = normalizePatch(patch);

  const addPaths = Object.keys(p.addNodes).sort((a, b) => pathDepth(a) - pathDepth(b));
  for (const path of addPaths) {
    const segments = parsePath(path);
    if (segments.length === 0) throw new PatchError('cannot add node at root path');
    const parent = getNode(root, segments.slice(0, -1));
    if (!parent) throw new PatchError(`addNodes: missing parent for path "${path}"`);
    const name = segments[segments.length - 1];
    if (parent.children[name]) throw new PatchError(`addNodes: node already exists at "${path}"`);
    parent.children[name] = normalizeTree(p.addNodes[path]);
  }

  const deletePaths = [...p.deleteNodes].sort((a, b) => pathDepth(a) - pathDepth(b));
  for (const path of deletePaths) {
    const segments = parsePath(path);
    if (segments.length === 0) throw new PatchError('cannot delete root node');
    const parent = getNode(root, segments.slice(0, -1));
    const name = segments[segments.length - 1];
    if (!parent || !parent.children[name]) {
      throw new PatchError(`deleteNodes: missing node at "${path}"`);
    }
    delete parent.children[name];
  }

  for (const [path, keys] of Object.entries(p.unset)) {
    const node = getNode(root, parsePath(path));
    if (!node) throw new PatchError(`unset: missing node at "${path}"`);
    for (const key of keys) delete node.thresholds[key];
  }

  for (const [path, values] of Object.entries(p.set)) {
    const node = getNode(root, parsePath(path));
    if (!node) throw new PatchError(`set: missing node at "${path}"`);
    Object.assign(node.thresholds, values);
  }

  return root;
}

function diffTrees(base, tip) {
  const baseRoot = normalizeTree(base);
  const tipRoot = normalizeTree(tip);
  const patch = emptyPatch();

  const walk = (baseNode, tipNode, segments) => {
    const path = joinPath(segments);
    for (const key of Object.keys(tipNode.thresholds).sort()) {
      if (!(key in baseNode.thresholds) || !deepEqual(baseNode.thresholds[key], tipNode.thresholds[key])) {
        if (!patch.set[path]) patch.set[path] = {};
        patch.set[path][key] = tipNode.thresholds[key];
      }
    }
    for (const key of Object.keys(baseNode.thresholds).sort()) {
      if (!(key in tipNode.thresholds)) {
        if (!patch.unset[path]) patch.unset[path] = [];
        patch.unset[path].push(key);
      }
    }
    for (const name of Object.keys(tipNode.children).sort()) {
      const baseChild = baseNode.children[name];
      const tipChild = tipNode.children[name];
      if (!baseChild) {
        patch.addNodes[joinPath([...segments, name])] = normalizeTree(tipChild);
      } else {
        walk(baseChild, tipChild, [...segments, name]);
      }
    }
    for (const name of Object.keys(baseNode.children).sort()) {
      if (!(name in tipNode.children)) {
        patch.deleteNodes.push(joinPath([...segments, name]));
      }
    }
  };

  walk(baseRoot, tipRoot, []);
  return prunePatch(patch);
}

module.exports = {
  PatchError,
  emptyPatch,
  normalizePatch,
  isEmptyPatch,
  prunePatch,
  applyPatch,
  diffTrees,
};
