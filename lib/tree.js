'use strict';

const crypto = require('node:crypto');

function normalizeNode(node) {
  const source = node || {};
  const children = {};
  for (const [name, child] of Object.entries(source.children || {})) {
    children[name] = normalizeNode(child);
  }
  return {
    thresholds: { ...(source.thresholds || {}) },
    children,
  };
}

function normalizeTree(tree) {
  return normalizeNode(tree);
}

function parsePath(path) {
  if (path === undefined || path === null) return [];
  return String(path).split('/').filter((segment) => segment.length > 0);
}

function joinPath(segments) {
  return segments.join('/');
}

function pathDepth(path) {
  return parsePath(path).length;
}

function isPrefixPath(prefix, path) {
  const pre = parsePath(prefix);
  const segs = parsePath(path);
  if (pre.length > segs.length) return false;
  return pre.every((segment, index) => segment === segs[index]);
}

function getNode(tree, segments) {
  let node = tree;
  for (const segment of segments) {
    if (!node || !node.children || !node.children[segment]) return null;
    node = node.children[segment];
  }
  return node;
}

function canonical(value) {
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonical(item)).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

function deepEqual(left, right) {
  return canonical(left) === canonical(right);
}

function sha256hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function stateHash(tree) {
  return sha256hex(canonical(normalizeTree(tree)));
}

function effectiveAt(tree, segments) {
  const effective = {};
  let node = tree;
  if (!node) return effective;
  Object.assign(effective, node.thresholds || {});
  for (const segment of segments) {
    node = node && node.children ? node.children[segment] : null;
    if (!node) break;
    Object.assign(effective, node.thresholds || {});
  }
  return effective;
}

function collectLeaves(tree) {
  const leaves = [];
  const walk = (node, segments) => {
    const names = Object.keys(node.children || {});
    if (names.length === 0) {
      leaves.push({ path: joinPath(segments), node });
      return;
    }
    for (const name of names) walk(node.children[name], [...segments, name]);
  };
  walk(normalizeTree(tree), []);
  return leaves;
}

function leafEffectiveStates(tree) {
  const normalized = normalizeTree(tree);
  const result = {};
  for (const leaf of collectLeaves(normalized)) {
    result[leaf.path] = effectiveAt(normalized, parsePath(leaf.path));
  }
  return result;
}

module.exports = {
  normalizeTree,
  normalizeNode,
  parsePath,
  joinPath,
  pathDepth,
  isPrefixPath,
  getNode,
  canonical,
  deepEqual,
  sha256hex,
  stateHash,
  effectiveAt,
  collectLeaves,
  leafEffectiveStates,
};
