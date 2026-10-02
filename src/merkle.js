'use strict';

const { sha256 } = require('./util');

// Merkle root over an array of hex leaf hashes. Odd levels duplicate the last node.
function merkleRoot(leaves) {
  if (!Array.isArray(leaves) || leaves.length === 0) return sha256('empty');
  let level = leaves.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(sha256(left + right));
    }
    level = next;
  }
  return level[0];
}

module.exports = { merkleRoot };
