'use strict';

const crypto = require('node:crypto');

class PathError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PathError';
    this.code = 'PATH';
  }
}

class PatchSequenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PatchSequenceError';
    this.code = 'PATCH_SEQUENCE';
  }
}

function canonical(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function stateHash(tree) {
  return crypto.createHash('sha256').update(canonical(tree)).digest('hex');
}

function shortHash(value) {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex').slice(0, 16);
}

function parsePath(path) {
  if (path === '/' || path === '') return [];
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new PathError(`invalid path: ${String(path)}`);
  }
  const segs = path.slice(1).split('/');
  if (segs.some((s) => s.length === 0)) {
    throw new PathError(`invalid path: ${path}`);
  }
  return segs;
}

function formatPath(segs) {
  return segs.length === 0 ? '/' : '/' + segs.join('/');
}

// True when `ancestor` is a strict ancestor path of `path` (ancestor is never '/').
function isPrefixPath(ancestor, path) {
  return path.startsWith(ancestor + '/');
}

function getNode(root, segs) {
  let node = root;
  for (const seg of segs) {
    const children = node.children || {};
    if (!Object.prototype.hasOwnProperty.call(children, seg)) {
      throw new PathError(`no such node: ${formatPath(segs)}`);
    }
    node = children[seg];
  }
  return node;
}

function normalizePatch(patch) {
  const out = { set: {}, unset: {}, delete: [] };
  const src = patch || {};
  for (const [path, kv] of Object.entries(src.set || {})) {
    const keys = Object.keys(kv || {});
    if (keys.length === 0) continue;
    out.set[path] = {};
    for (const key of keys.sort()) out.set[path][key] = kv[key];
  }
  for (const [path, keys] of Object.entries(src.unset || {})) {
    const uniq = [...new Set(keys)].sort();
    if (uniq.length > 0) out.unset[path] = uniq;
  }
  out.delete = [...new Set(src.delete || [])].sort();
  return out;
}

class PatchBuilder {
  constructor() {
    this.setMap = new Map(); // path -> {key: value}
    this.unsetMap = new Map(); // path -> Set(key)
    this.deletes = [];
  }

  addDelete(path) {
    if (path === '/' || path === '') {
      throw new PatchSequenceError('cannot delete the root node');
    }
    if (this.deletes.some((d) => d === path || isPrefixPath(d, path))) return;
    this.deletes = this.deletes.filter((d) => !isPrefixPath(path, d));
    for (const p of [...this.setMap.keys()]) {
      if (p === path || isPrefixPath(path, p)) this.setMap.delete(p);
    }
    for (const p of [...this.unsetMap.keys()]) {
      if (p === path || isPrefixPath(path, p)) this.unsetMap.delete(p);
    }
    this.deletes.push(path);
  }

  addSet(path, key, value) {
    if (this.deletes.some((d) => d === path || isPrefixPath(d, path))) {
      throw new PatchSequenceError(`cannot set ${key} on deleted node ${path}`);
    }
    if (!this.setMap.has(path)) this.setMap.set(path, {});
    this.setMap.get(path)[key] = value;
    const unset = this.unsetMap.get(path);
    if (unset) {
      unset.delete(key);
      if (unset.size === 0) this.unsetMap.delete(path);
    }
  }

  addUnset(path, key) {
    if (this.deletes.some((d) => d === path || isPrefixPath(d, path))) {
      throw new PatchSequenceError(`cannot unset ${key} on deleted node ${path}`);
    }
    const set = this.setMap.get(path);
    if (set && Object.prototype.hasOwnProperty.call(set, key)) {
      delete set[key];
      if (Object.keys(set).length === 0) this.setMap.delete(path);
    }
    if (!this.unsetMap.has(path)) this.unsetMap.set(path, new Set());
    this.unsetMap.get(path).add(key);
  }

  toPatch() {
    const set = {};
    for (const [path, kv] of this.setMap) set[path] = kv;
    const unset = {};
    for (const [path, keys] of this.unsetMap) unset[path] = [...keys];
    return normalizePatch({ set, unset, delete: this.deletes });
  }
}

function applyToBuilder(builder, patch) {
  const normalized = normalizePatch(patch);
  for (const path of normalized.delete) builder.addDelete(path);
  for (const [path, keys] of Object.entries(normalized.unset)) {
    for (const key of keys) builder.addUnset(path, key);
  }
  for (const [path, kv] of Object.entries(normalized.set)) {
    for (const [key, value] of Object.entries(kv)) builder.addSet(path, key, value);
  }
}

function composePatches(first, second) {
  const builder = new PatchBuilder();
  applyToBuilder(builder, first);
  applyToBuilder(builder, second);
  return builder.toPatch();
}

function applyPatch(tree, patch) {
  const root = structuredClone(tree);
  const normalized = normalizePatch(patch);
  for (const path of normalized.delete) {
    const segs = parsePath(path);
    if (segs.length === 0) throw new PathError('cannot delete the root node');
    const parent = getNode(root, segs.slice(0, -1));
    const name = segs[segs.length - 1];
    if (!parent.children || !Object.prototype.hasOwnProperty.call(parent.children, name)) {
      throw new PathError(`no such node: ${path}`);
    }
    delete parent.children[name];
  }
  for (const [path, keys] of Object.entries(normalized.unset)) {
    const node = getNode(root, parsePath(path));
    if (node.thresholds) {
      for (const key of keys) delete node.thresholds[key];
    }
  }
  for (const [path, kv] of Object.entries(normalized.set)) {
    const node = getNode(root, parsePath(path));
    if (!node.thresholds) node.thresholds = {};
    Object.assign(node.thresholds, kv);
  }
  return root;
}

// Effective thresholds at a node: nearest ancestor override wins per key.
function effectiveAt(root, segs) {
  const effective = {};
  let node = root;
  Object.assign(effective, node.thresholds || {});
  for (const seg of segs) {
    const children = node.children || {};
    if (!Object.prototype.hasOwnProperty.call(children, seg)) {
      throw new PathError(`no such node: ${formatPath(segs)}`);
    }
    node = children[seg];
    Object.assign(effective, node.thresholds || {});
  }
  return effective;
}

function leafEffectiveThresholds(root) {
  const result = {};
  const visit = (node, segs, inherited) => {
    const effective = { ...inherited, ...(node.thresholds || {}) };
    const children = node.children || {};
    const names = Object.keys(children);
    if (names.length === 0) {
      result[formatPath(segs)] = effective;
      return;
    }
    for (const name of names) visit(children[name], [...segs, name], effective);
  };
  visit(root, [], {});
  return result;
}

// Diff tree `from` into tree `to`; only deletes/unsets/sets are expressible,
// so `to` must not contain nodes missing from `from`.
function diffTrees(from, to) {
  const builder = new PatchBuilder();
  const walk = (a, b, segs) => {
    const path = formatPath(segs);
    const aTh = a.thresholds || {};
    const bTh = b.thresholds || {};
    for (const key of Object.keys(aTh)) {
      if (!Object.prototype.hasOwnProperty.call(bTh, key)) builder.addUnset(path, key);
    }
    for (const key of Object.keys(bTh)) {
      if (!Object.prototype.hasOwnProperty.call(aTh, key) || canonical(aTh[key]) !== canonical(bTh[key])) {
        builder.addSet(path, key, bTh[key]);
      }
    }
    const aChildren = a.children || {};
    const bChildren = b.children || {};
    for (const [name, child] of Object.entries(aChildren)) {
      if (!Object.prototype.hasOwnProperty.call(bChildren, name)) {
        builder.addDelete(formatPath([...segs, name]));
      } else {
        walk(child, bChildren[name], [...segs, name]);
      }
    }
    for (const name of Object.keys(bChildren)) {
      if (!Object.prototype.hasOwnProperty.call(aChildren, name)) {
        throw new PatchSequenceError(`diff cannot create node ${formatPath([...segs, name])}`);
      }
    }
  };
  walk(from, to, []);
  return builder.toPatch();
}

module.exports = {
  PathError,
  PatchSequenceError,
  canonical,
  stateHash,
  shortHash,
  parsePath,
  formatPath,
  isPrefixPath,
  getNode,
  normalizePatch,
  PatchBuilder,
  applyToBuilder,
  composePatches,
  applyPatch,
  effectiveAt,
  leafEffectiveThresholds,
  diffTrees,
};
