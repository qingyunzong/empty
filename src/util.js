'use strict';
const crypto = require('node:crypto');

const RULES_VERSION = 'evidence-pack-rules/1.0.0';

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

function canonicalHash(value) {
  return sha256Hex(canonicalize(value));
}

function compareKeys(a, b) {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  if (a.client !== b.client) return a.client < b.client ? -1 : 1;
  if (a.hash !== b.hash) return a.hash < b.hash ? -1 : 1;
  return 0;
}

module.exports = { RULES_VERSION, sha256Hex, canonicalize, canonicalHash, compareKeys };
