'use strict';

const crypto = require('node:crypto');

// Canonical JSON: object keys sorted recursively, no whitespace.
// Numbers must be safe integers (amounts are integer minor units).
function canonical(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean' || t === 'string') return JSON.stringify(value);
  if (t === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`non-integer number not allowed in canonical JSON: ${value}`);
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']';
  }
  if (t === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  throw new Error(`unsupported type in canonical JSON: ${t}`);
}

function sha256hex(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function hashCanonical(value) {
  return sha256hex(canonical(value));
}

module.exports = { canonical, sha256hex, hashCanonical };
