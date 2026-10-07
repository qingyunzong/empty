'use strict';

const crypto = require('node:crypto');

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// Merkle root over an ordered list of canonical leaf strings.
function merkleRoot(leaves) {
  if (leaves.length === 0) return sha256('empty');
  let level = leaves.map((l) => sha256(`leaf:${l}`));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(sha256(`node:${a}${b}`));
    }
    level = next;
  }
  return level[0];
}

module.exports = { sha256, merkleRoot };
