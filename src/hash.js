import { createHash } from 'node:crypto';

export function canonical(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function sha256hex(data) {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

export const GENESIS = sha256hex('audit-ledger/genesis');
export const EMPTY_ROOT = sha256hex('audit-ledger/empty-root');

function nodeHash(left, right) {
  return sha256hex('node:' + left + ':' + right);
}

export function merkleRoot(leaves) {
  if (leaves.length === 0) return EMPTY_ROOT;
  let level = leaves.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = i + 1 < level.length ? level[i + 1] : a;
      next.push(nodeHash(a, b));
    }
    level = next;
  }
  return level[0];
}

export function merkleProof(leaves, index) {
  if (index < 0 || index >= leaves.length) {
    throw new RangeError('merkleProof: index out of range');
  }
  const proof = [];
  let level = leaves.slice();
  let idx = index;
  while (level.length > 1) {
    const sibling = idx % 2 === 0 ? idx + 1 : idx - 1;
    const siblingHash = sibling < level.length ? level[sibling] : level[idx];
    proof.push({ hash: siblingHash, side: idx % 2 === 0 ? 'R' : 'L' });
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = i + 1 < level.length ? level[i + 1] : a;
      next.push(nodeHash(a, b));
    }
    level = next;
    idx = Math.floor(idx / 2);
  }
  return proof;
}

export function verifyProof(leafHash, proof, root) {
  let acc = leafHash;
  for (const step of proof) {
    acc = step.side === 'L' ? nodeHash(step.hash, acc) : nodeHash(acc, step.hash);
  }
  return acc === root;
}
