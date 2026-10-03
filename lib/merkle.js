'use strict';

const crypto = require('node:crypto');
const { stableStringify } = require('./frame');

function leafHash(ev) {
  return crypto.createHash('sha256').update('leaf:').update(stableStringify(ev)).digest('hex');
}

function nodeHash(left, right) {
  return crypto.createHash('sha256').update('node:').update(left).update(right).digest('hex');
}

// Merkle root over event objects (in canonical order). Odd levels duplicate the last hash.
function merkleRoot(events) {
  if (events.length === 0) {
    return crypto.createHash('sha256').update('empty').digest('hex');
  }
  let level = events.map(leafHash);
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(nodeHash(level[i], i + 1 < level.length ? level[i + 1] : level[i]));
    }
    level = next;
  }
  return level[0];
}

module.exports = { leafHash, nodeHash, merkleRoot };
