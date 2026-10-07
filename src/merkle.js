import { createHash } from 'node:crypto';
import { canonical } from './canonical.js';

export function sha256hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

export function leafHash(entry) {
  return sha256hex('leaf:' + canonical(entry));
}

// Merkle-style root over an ordered list of leaf hashes.
// Odd nodes are duplicated; empty tree hashes the empty string.
export function merkleRoot(leaves) {
  if (leaves.length === 0) return sha256hex('');
  let level = leaves.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left;
      next.push(sha256hex('node:' + left + right));
    }
    level = next;
  }
  return level[0];
}
