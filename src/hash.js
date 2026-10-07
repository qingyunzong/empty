'use strict';

const crypto = require('node:crypto');

function sha256hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

// Canonical JSON: object keys sorted recursively so hashing is stable.
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

function hashCanonical(value) {
  return sha256hex(canonicalize(value));
}

// Hash of an ordered list of hit ids (order matters: ids are sorted by caller).
function hashHitIds(ids) {
  return sha256hex('hits:' + ids.join(','));
}

module.exports = { sha256hex, canonicalize, hashCanonical, hashHitIds };
