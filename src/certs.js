import { sha256 } from './hash.js';
import { LineageError, E_PROOF } from './errors.js';

// Certificate: binds batch id to its parent hashes, remark text hash and
// tombstone bit. Hash-chained through parents' certificate hashes.
export function makeCert({ id, parentHashes, textHash, tombstone, version }) {
  const parentHash = sha256(parentHashes.slice().sort().join('|'));
  const body = [id, parentHash, textHash, tombstone ? 1 : 0, version].join('|');
  return {
    id,
    version,
    parentHash,
    textHash,
    tombstone: tombstone ? 1 : 0,
    hash: sha256(body),
  };
}

// Append-only Merkle log over certificate hashes; yields inclusion proofs.
export class MerkleLog {
  constructor() {
    this.leaves = [];
  }

  append(hash) {
    this.leaves.push(hash);
    return this.leaves.length - 1;
  }

  get root() {
    return MerkleLog.rootOf(this.leaves);
  }

  static rootOf(leaves) {
    if (leaves.length === 0) return sha256('');
    let level = leaves.slice();
    while (level.length > 1) {
      const next = [];
      for (let i = 0; i < level.length; i += 2) {
        const l = level[i];
        const r = i + 1 < level.length ? level[i + 1] : level[i];
        next.push(sha256(l + r));
      }
      level = next;
    }
    return level[0];
  }

  prove(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.leaves.length) {
      throw new LineageError(E_PROOF, `no leaf at index ${index}`);
    }
    const path = [];
    let idx = index;
    let level = this.leaves.slice();
    while (level.length > 1) {
      const sib = idx % 2 === 0 ? idx + 1 : idx - 1;
      const sibHash = sib < level.length ? level[sib] : level[idx];
      path.push({ hash: sibHash, side: idx % 2 === 0 ? 'right' : 'left' });
      idx = Math.floor(idx / 2);
      const next = [];
      for (let i = 0; i < level.length; i += 2) {
        const l = level[i];
        const r = i + 1 < level.length ? level[i + 1] : level[i];
        next.push(sha256(l + r));
      }
      level = next;
    }
    return { leaf: this.leaves[index], index, path, root: this.root };
  }
}

export function verifyProof(proof) {
  if (
    !proof ||
    typeof proof.leaf !== 'string' ||
    typeof proof.root !== 'string' ||
    !Array.isArray(proof.path)
  ) {
    throw new LineageError(E_PROOF, 'malformed proof');
  }
  let h = proof.leaf;
  for (const step of proof.path) {
    if (!step || typeof step.hash !== 'string') {
      throw new LineageError(E_PROOF, 'malformed proof step');
    }
    if (step.side === 'right') h = sha256(h + step.hash);
    else if (step.side === 'left') h = sha256(step.hash + h);
    else throw new LineageError(E_PROOF, `bad proof step side: ${step.side}`);
  }
  return h === proof.root;
}
