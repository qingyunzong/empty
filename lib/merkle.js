'use strict';

const { createHash } = require('node:crypto');

const CHUNK_SIZE = 1024;

function sha256(buf) {
  return createHash('sha256').update(buf).digest();
}

// Deterministic Merkle root over the assembled payload: leaves are sha256 of
// fixed-size chunks, parents are sha256 of concatenated children, the last
// node is duplicated when a level is odd.
function merkleRoot(payload, chunkSize = CHUNK_SIZE) {
  if (payload.length === 0) return sha256(Buffer.alloc(0)).toString('hex');
  let level = [];
  for (let off = 0; off < payload.length; off += chunkSize) {
    level.push(sha256(payload.subarray(off, Math.min(off + chunkSize, payload.length))));
  }
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(sha256(Buffer.concat([level[i], right])));
    }
    level = next;
  }
  return level[0].toString('hex');
}

module.exports = { merkleRoot, sha256, CHUNK_SIZE };
