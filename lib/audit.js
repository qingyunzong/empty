'use strict';

const crypto = require('node:crypto');

const GENESIS = '0'.repeat(64);

// Append-only hash chain: each entry hashes the previous hash plus the exact
// decision JSONL line, so historical entries cannot be altered or reordered
// without changing every subsequent hash.
function chainHash(prevHash, line) {
  return crypto.createHash('sha256').update(prevHash + '\n' + line).digest('hex');
}

// decisions: array of decision objects (serialized with JSON.stringify).
// Returns { lines, audit } where lines are the JSONL output lines and audit
// is the audit.json document.
function buildAudit(decisions) {
  const lines = [];
  const entries = [];
  let prev = GENESIS;
  decisions.forEach((decision, i) => {
    const line = JSON.stringify(decision);
    const hash = chainHash(prev, line);
    lines.push(line);
    entries.push({ seq: i + 1, id: decision.id, hash });
    prev = hash;
  });
  const audit = {
    algorithm: 'sha256-chain',
    genesis: GENESIS,
    count: decisions.length,
    finalHash: prev,
    entries,
  };
  return { lines, audit };
}

module.exports = { GENESIS, chainHash, buildAudit };
