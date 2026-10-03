'use strict';

const { createHash } = require('node:crypto');

// Deterministic JSON serialization: object keys sorted recursively.
function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

function sha256hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

module.exports = { canonicalize, sha256hex };
