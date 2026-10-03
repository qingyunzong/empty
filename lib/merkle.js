'use strict';
const { canon, sha256hex } = require('./util');

function leafHash(entry) {
  return sha256hex('leaf:' + canon(entry));
}

function merkleRoot(leaves) {
  if (leaves.length === 0) return sha256hex('empty');
  let level = leaves.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? sha256hex('node:' + level[i] + level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0];
}

module.exports = { leafHash, merkleRoot };
