// Independent brute-force reference implementations, written separately from
// src/ so the tests cross-check the library rather than mirror it.
import { createHash } from 'node:crypto';

function sha(s) {
  return createHash('sha256').update(s).digest('hex');
}

function canon(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  return '{' + Object.keys(v).sort()
    .reduce((acc, k) => acc.concat(JSON.stringify(k) + ':' + canon(v[k])), [])
    .join(',') + '}';
}

export function refBlockHash(block) {
  return sha(canon({
    index: block.index, epoch: block.epoch, prev: block.prev, data: block.data,
  }));
}

// Recompute the whole chain by brute force from raw block objects.
export function refChain(blocks) {
  let prev = '0'.repeat(64);
  const hashes = [];
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].prev !== prev) throw new Error(`chain broken at ${i}`);
    const h = refBlockHash(blocks[i]);
    hashes.push(h);
    prev = h;
  }
  return { head: prev, hashes };
}

// Recursive reference: split at the largest power of two strictly below n.
export function refMerkleRoot(blockHashes) {
  if (blockHashes.length === 0) return sha('evpack:empty');
  const leaves = blockHashes.map((h) => sha('evpack:leaf:' + h));
  const rec = (level) => {
    if (level.length === 1) return level[0];
    let p = 1;
    while (p * 2 < level.length) p *= 2;
    return sha('evpack:node:' + rec(level.slice(0, p)) + rec(level.slice(p)));
  };
  return rec(leaves);
}
