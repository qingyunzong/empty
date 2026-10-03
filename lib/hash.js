'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hashFile(p) {
  return sha256(fs.readFileSync(p));
}

// Convergence hash of a directory scan: order-independent over key->hash pairs.
function scanHash(scan) {
  const lines = [...scan.keys()].sort().map((k) => `${k}:${scan.get(k).hash}`);
  return sha256(lines.join('\n'));
}

module.exports = { sha256, hashFile, scanHash };
