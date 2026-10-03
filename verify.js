#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { leafHash, merkleRoot } = require('./lib/merkle');

// Returns {code, out}; verifies a period certificate: leaf hashes, Merkle
// root, and balance replay from initialBalances over the period log.
function run(argv) {
  const certPath = argv[0];
  if (!certPath) return { code: 64, out: '', err: 'usage: node verify.js <cert.json>\n' };
  const cert = JSON.parse(fs.readFileSync(certPath, 'utf8'));
  const checks = {};

  const leaves = (cert.log || []).map(leafHash);
  checks.leaves = JSON.stringify(leaves) === JSON.stringify(cert.leaves);
  checks.root = merkleRoot(leaves) === cert.root;

  const balances = { ...(cert.initialBalances || {}) };
  for (const e of cert.log || []) {
    balances[e.acct] = (balances[e.acct] || 0) + e.amount;
  }
  const sortObj = (o) => Object.fromEntries(Object.entries(o).sort());
  checks.balances = JSON.stringify(sortObj(balances)) === JSON.stringify(sortObj(cert.balances || {}));

  const ok = Object.values(checks).every(Boolean);
  const out = JSON.stringify({ ok, periodId: cert.periodId, root: cert.root, checks }, null, 2) + '\n';
  return { code: ok ? 0 : 1, out, err: '' };
}

if (require.main === module) {
  const r = run(process.argv.slice(2));
  if (r.out) process.stdout.write(r.out);
  if (r.err) process.stderr.write(r.err);
  process.exitCode = r.code;
}

module.exports = { run };
