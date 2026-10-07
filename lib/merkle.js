'use strict';

const { createHash } = require('node:crypto');

function sha256(buf) {
  return createHash('sha256').update(buf).digest();
}

// Leaves are text labels like "T12" (trades.jsonl line 12) or "C7"
// (cancels.jsonl line 7). Odd nodes are promoted unchanged.
function merkleRoot(labels) {
  if (labels.length === 0) {
    throw new Error('merkleRoot requires at least one leaf');
  }
  let level = labels.map((label) => sha256(Buffer.from(label, 'utf8')));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        next.push(sha256(Buffer.concat([level[i], level[i + 1]])));
      } else {
        next.push(level[i]);
      }
    }
    level = next;
  }
  return level[0].toString('hex');
}

module.exports = { merkleRoot, sha256 };
