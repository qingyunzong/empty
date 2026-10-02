'use strict';

const crypto = require('node:crypto');

// Deterministic canonical serialization: object keys sorted recursively.
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function sha256hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function hashObject(obj) {
  return sha256hex(canonical(obj));
}

module.exports = { canonical, sha256hex, hashObject };
