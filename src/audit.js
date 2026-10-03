'use strict';

const crypto = require('node:crypto');

function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Append-only audit log; auditRoot is a Merkle root over event hashes.
class AuditLog {
  constructor() {
    this.leaves = [];
  }

  append(event) {
    const leaf = sha256hex(JSON.stringify(event));
    this.leaves.push(leaf);
    return leaf;
  }

  root() {
    if (this.leaves.length === 0) return sha256hex('');
    let level = [...this.leaves];
    while (level.length > 1) {
      const next = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i];
        const right = i + 1 < level.length ? level[i + 1] : left;
        next.push(sha256hex(left + right));
      }
      level = next;
    }
    return level[0];
  }
}

module.exports = { AuditLog, sha256hex };
