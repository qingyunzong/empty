'use strict';

const crypto = require('node:crypto');

// Canonical serialization: object keys sorted recursively, no whitespace.
function canon(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(value[k])).join(',') + '}';
}

function sha256hex(text) {
  return crypto.hash('sha256', text, 'hex');
}

module.exports = { canon, sha256hex };
