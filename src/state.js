'use strict';

const crypto = require('node:crypto');

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k]);
    return out;
  }
  return value;
}

function canonicalString(state) {
  return JSON.stringify(canonicalize(state));
}

// Lineage hash of a state snapshot (nodes, statuses, ledger, config).
// The generation counter is excluded: it identifies a commit, not lineage
// content, so rolling back to a generation reproduces its recorded hash.
function rootHash(state) {
  const { generation, ...content } = state;
  return crypto.createHash('sha256').update(canonicalString(content)).digest('hex');
}

function emptyState(config) {
  return {
    version: 1,
    generation: 0,
    machine: { cpus: config.cpus, mem: config.mem },
    quotas: { ...(config.quotas ?? {}) },
    nodes: {},
    ledger: {},
    completedBytes: {},
  };
}

module.exports = { canonicalize, canonicalString, rootHash, emptyState };
