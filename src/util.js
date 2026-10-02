'use strict';

const crypto = require('node:crypto');

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Deterministic JSON serialization with recursively sorted object keys.
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function hashObject(obj) {
  return sha256(canonical(obj));
}

// Deterministic selection key for a record within a stratum.
// Pure function of (seed, stratum, recordId): reproducible across runs and versions.
function selectionKey(seed, stratum, recordId) {
  return sha256('sample|' + seed + '|' + stratum + '|' + recordId);
}

module.exports = { sha256, canonical, hashObject, selectionKey };
