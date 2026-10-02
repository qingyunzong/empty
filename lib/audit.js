'use strict';

const crypto = require('crypto');

// Deterministic JSON: object keys sorted, no whitespace.
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

const GENESIS = '0'.repeat(64);

// Hash chain over decisions: each entry's hash commits to the previous
// hash and the canonical decision payload, so history cannot be altered
// without changing every subsequent hash.
class AuditChain {
  constructor() {
    this.head = GENESIS;
    this.count = 0;
  }

  append(decision) {
    const hash = sha256(`${this.head}\n${canonical(decision)}`);
    this.head = hash;
    this.count += 1;
    return hash;
  }
}

module.exports = { canonical, sha256, AuditChain, GENESIS };
