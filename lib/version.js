'use strict';

const crypto = require('node:crypto');
const { normalizeClock, isRegression } = require('./vclock');

class LineageError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LineageError';
    this.code = code;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalize(value[k]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

function sortEvidence(evidence) {
  return [...evidence].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

// Lineage hash: sha256 over the canonical encoding of the version payload.
function computeHash(version) {
  const payload = {
    author: version.author,
    clock: normalizeClock(version.clock),
    parents: [...version.parents].sort(),
    results: version.results,
    evidence: sortEvidence(version.evidence),
  };
  return crypto.createHash('sha256').update(canonicalize(payload)).digest('hex');
}

function checkStructure(version) {
  if (version === null || typeof version !== 'object' || Array.isArray(version)) {
    throw new LineageError('version must be an object', 'INVALID_VERSION');
  }
  if (typeof version.author !== 'string' || version.author.length === 0) {
    throw new LineageError('version.author must be a non-empty string', 'INVALID_VERSION');
  }
  if (version.clock === undefined) {
    throw new LineageError('version.clock is required', 'INVALID_VERSION');
  }
  if (!Array.isArray(version.parents)) {
    throw new LineageError('version.parents must be an array of hashes', 'INVALID_VERSION');
  }
  for (const p of version.parents) {
    if (typeof p !== 'string' || p.length === 0) {
      throw new LineageError('version.parents entries must be non-empty strings', 'INVALID_VERSION');
    }
  }
  if (version.results === null || typeof version.results !== 'object' || Array.isArray(version.results)) {
    throw new LineageError('version.results must be an object (structured result table)', 'INVALID_VERSION');
  }
  if (!Array.isArray(version.evidence)) {
    throw new LineageError('version.evidence must be an array', 'INVALID_VERSION');
  }
  const seen = new Set();
  for (const item of version.evidence) {
    if (item === null || typeof item !== 'object' || typeof item.id !== 'string' || item.id.length === 0) {
      throw new LineageError('each evidence entry needs a non-empty string id', 'INVALID_VERSION');
    }
    if (seen.has(item.id)) {
      throw new LineageError(`duplicate evidence id "${item.id}"`, 'DUPLICATE_EVIDENCE');
    }
    seen.add(item.id);
  }
}

// Full validation: structure, duplicate evidence ids, known parents,
// no clock regression relative to any parent.
function validateVersion(version, store) {
  checkStructure(version);
  const clock = normalizeClock(version.clock);
  for (const parentHash of version.parents) {
    if (!store.has(parentHash)) {
      throw new LineageError(`unknown parent reference "${parentHash}"`, 'UNKNOWN_PARENT');
    }
    const parent = store.get(parentHash);
    if (isRegression(normalizeClock(parent.clock), clock)) {
      throw new LineageError(
        `clock regression: version clock ${JSON.stringify(clock)} is behind parent ${parentHash}`,
        'CLOCK_REGRESSION',
      );
    }
  }
  return version;
}

module.exports = {
  LineageError,
  canonicalize,
  computeHash,
  validateVersion,
};
