'use strict';
const { createHash } = require('node:crypto');

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
  return out;
}

function canonicalJSON(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return createHash('sha256').update(canonicalJSON(value), 'utf8').digest('hex');
}

function compareCanonical(a, b) {
  const sa = canonicalJSON(a);
  const sb = canonicalJSON(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

// A plan is a *set* of allocations; normalize by canonicalizing each
// allocation and sorting them so equivalent sets compare equal.
function normalizePlan(plan) {
  if (!Array.isArray(plan)) {
    throw new Error('plan must be an array of allocations');
  }
  return plan.map((a) => canonicalize(a)).sort(compareCanonical);
}

module.exports = { canonicalize, canonicalJSON, sha256, compareCanonical, normalizePlan };
