import { createHash } from 'node:crypto';

// Deterministic serialization: sorted object keys, BigInt as decimal string.
export function canon(v) {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

export const sha256hex = (s) => createHash('sha256').update(s).digest('hex');

// Merkle root over an array of leaf hashes (hex). Odd levels duplicate the last node.
export function merkleRoot(leaves) {
  if (leaves.length === 0) return sha256hex('');
  let level = leaves.map((h) => Buffer.from(h, 'hex'));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(createHash('sha256').update(Buffer.concat([a, b])).digest());
    }
    level = next;
  }
  return level[0].toString('hex');
}
