'use strict';
const { createHash } = require('node:crypto');

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function hashValue(value) {
  return sha256(canonical(value));
}

function commitHash(commit) {
  return hashValue({
    parent: commit.parent,
    number: commit.number,
    patch: commit.patch,
    context: commit.context,
  });
}

module.exports = { canonical, sha256, hashValue, commitHash };
