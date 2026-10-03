import { createHash } from 'node:crypto';

export function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

export function hashRecord(record) {
  return sha256(canonical(record));
}

export function merkleRoot(leaves) {
  if (leaves.length === 0) return sha256('');
  let level = leaves.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(sha256(level[i] + right));
    }
    level = next;
  }
  return level[0];
}

export function merkleProof(leaves, index) {
  const proof = [];
  let idx = index;
  let level = leaves.slice();
  while (level.length > 1) {
    const sibling = idx % 2 === 0 ? idx + 1 : idx - 1;
    const siblingHash = sibling < level.length ? level[sibling] : level[idx];
    proof.push({ hash: siblingHash, pos: idx % 2 === 0 ? 'R' : 'L' });
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(sha256(level[i] + right));
    }
    idx = Math.floor(idx / 2);
    level = next;
  }
  return proof;
}

export function verifyMerkle(leafHash, proof, root) {
  let hash = leafHash;
  for (const step of proof) {
    hash = step.pos === 'R' ? sha256(hash + step.hash) : sha256(step.hash + hash);
  }
  return hash === root;
}
