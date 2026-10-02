'use strict';

// Deterministic JSON: sorted object keys, no whitespace, finite numbers only.
function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('canonicalize: non-finite number');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const parts = keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k]));
    return '{' + parts.join(',') + '}';
  }
  throw new Error('canonicalize: unsupported type ' + typeof value);
}

module.exports = { canonicalize };
