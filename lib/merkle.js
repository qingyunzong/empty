'use strict';

const { createHash } = require('node:crypto');

function sha256(...parts) {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

function leafHash(index, generation, crc, data) {
  const head = Buffer.alloc(12);
  head.writeUInt32LE(index >>> 0, 0);
  head.writeUInt32LE(generation >>> 0, 4);
  head.writeUInt32LE(crc >>> 0, 8);
  return sha256(head, data);
}

function merkleRoot(leaves) {
  if (!leaves.length) throw new Error('merkleRoot: no leaves');
  let level = leaves.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? sha256(level[i], level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0];
}

module.exports = { sha256, leafHash, merkleRoot };
