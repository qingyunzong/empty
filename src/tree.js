'use strict';

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function parsePath(path) {
  if (Array.isArray(path)) return path.slice();
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error(`invalid path: ${String(path)}`);
  }
  return path.split('.');
}

function has(tree, path) {
  let node = tree;
  for (const key of parsePath(path)) {
    if (node === null || typeof node !== 'object' || !(key in node)) return false;
    node = node[key];
  }
  return true;
}

function get(tree, path) {
  let node = tree;
  for (const key of parsePath(path)) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[key];
  }
  return node;
}

function set(tree, path, value) {
  const keys = parsePath(path);
  let node = tree;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i];
    if (node[key] === null || typeof node[key] !== 'object') node[key] = {};
    node = node[key];
  }
  node[keys[keys.length - 1]] = clone(value);
  return tree;
}

function del(tree, path) {
  const keys = parsePath(path);
  let node = tree;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (node === null || typeof node !== 'object') return false;
    node = node[keys[i]];
  }
  if (node === null || typeof node !== 'object') return false;
  const last = keys[keys.length - 1];
  if (!(last in node)) return false;
  delete node[last];
  return true;
}

module.exports = { clone, parsePath, has, get, set, del };
