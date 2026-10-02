'use strict';

// Canonical (stable) JSON serialization: object keys sorted recursively,
// so logically equal values always hash identically.
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonicalize(value[key]);
  }
  return out;
}

function canon(value) {
  return JSON.stringify(canonicalize(value));
}

module.exports = { canon, canonicalize };
