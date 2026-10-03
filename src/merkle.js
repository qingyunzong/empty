'use strict';
const { sha256 } = require('./canon');

function leafHash(entry) {
  return sha256('leaf|' + JSON.stringify(entry));
}

function merkleRoot(leaves) {
  if (leaves.length === 0) return sha256('empty');
  let level = leaves.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(sha256('node|' + level[i] + '|' + right));
    }
    level = next;
  }
  return level[0];
}

function certificate(leaves) {
  return {
    algorithm: 'sha256',
    leafCount: leaves.length,
    root: merkleRoot(leaves),
    leaves: leaves.slice(),
  };
}

module.exports = { leafHash, merkleRoot, certificate };
