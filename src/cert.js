'use strict';

const crypto = require('node:crypto');

// Canonical JSON: object keys sorted recursively, so hashing is order-stable.
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`);
  return `{${parts.join(',')}}`;
}

function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Canonical row order: sort rows by their canonical JSON encoding.
function canonicalRowOrder(rows) {
  return rows.map(canonical).sort();
}

// Certificate: sha256 chain over canonically ordered rows, seeded with the
// digests of the input files so the certificate binds outputs to inputs.
function makeCert(rows, inputDigests) {
  const ordered = canonicalRowOrder(rows);
  const header = canonical({ version: 1, algorithm: 'sha256-chain', inputs: inputDigests });
  let head = sha256hex(header);
  const chain = [];
  for (const rowCanon of ordered) {
    head = sha256hex(`${head}:${rowCanon}`);
    chain.push(head);
  }
  return {
    version: 1,
    algorithm: 'sha256-chain',
    inputs: inputDigests,
    row_count: ordered.length,
    root: head,
    chain,
  };
}

// Recomputes the certificate from result rows (+ optionally live input
// digests) and compares. Returns { ok, reason }.
function verifyCert(rows, cert, actualInputDigests) {
  if (!cert || typeof cert !== 'object') return { ok: false, reason: 'certificate missing or malformed' };
  if (cert.version !== 1 || cert.algorithm !== 'sha256-chain') {
    return { ok: false, reason: 'unsupported certificate version/algorithm' };
  }
  if (actualInputDigests) {
    for (const [name, digest] of Object.entries(actualInputDigests)) {
      if (!cert.inputs || cert.inputs[name] !== digest) {
        return { ok: false, reason: `input digest mismatch for ${name}` };
      }
    }
  }
  const expected = makeCert(rows, cert.inputs || {});
  if (expected.row_count !== cert.row_count) return { ok: false, reason: 'row_count mismatch' };
  if (expected.root !== cert.root) return { ok: false, reason: 'root hash mismatch' };
  if (!Array.isArray(cert.chain) || cert.chain.length !== expected.chain.length) {
    return { ok: false, reason: 'chain length mismatch' };
  }
  for (let i = 0; i < expected.chain.length; i += 1) {
    if (expected.chain[i] !== cert.chain[i]) return { ok: false, reason: `chain mismatch at link ${i}` };
  }
  return { ok: true };
}

module.exports = { canonical, sha256hex, canonicalRowOrder, makeCert, verifyCert };
