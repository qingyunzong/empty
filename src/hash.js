'use strict';
const crypto = require('node:crypto');

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// Deterministic JSON serialization: object keys sorted recursively.
function canonical(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

function hashObj(value) {
  return sha256(canonical(value));
}

module.exports = { sha256, canonical, hashObj };
