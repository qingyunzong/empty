import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomInt } from 'node:crypto';
import { merkleRoot, merkleProof, verifyProof } from '../lib/merkle.js';
import { noProof, NO_PROOF } from '../lib/errors.js';

function refLeaf(leafHex) {
  return createHash('sha256').update(Buffer.concat([Buffer.from([0]), Buffer.from(leafHex, 'hex')])).digest('hex');
}

function refNode(a, b) {
  return createHash('sha256').update(Buffer.concat([Buffer.from([1]), Buffer.from(a, 'hex'), Buffer.from(b, 'hex')])).digest('hex');
}

function refRoot(leaves) {
  if (leaves.length === 0) return null;
  let level = leaves.map(refLeaf);
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? refNode(level[i], level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0];
}

function refRootFromProof(leafHex, index, path) {
  let acc = refLeaf(leafHex);
  for (const step of path) {
    acc = step.position === 'left' ? refNode(step.hash, acc) : refNode(acc, step.hash);
  }
  return acc;
}

function randomLeaves(count) {
  return Array.from({ length: count }, () => createHash('sha256').update(String(Math.random())).digest('hex'));
}

test('merkle root matches brute-force reference for sizes 1..64', () => {
  for (let n = 1; n <= 64; n++) {
    const leaves = randomLeaves(n);
    assert.equal(merkleRoot(leaves), refRoot(leaves), `root mismatch at n=${n}`);
  }
});

test('proofs verify and match brute-force recomputation for every leaf', () => {
  for (const n of [1, 2, 3, 5, 8, 13, 16, 31, 33, 64]) {
    const leaves = randomLeaves(n);
    const root = refRoot(leaves);
    for (let i = 0; i < n; i++) {
      const proof = merkleProof(leaves, i);
      assert.equal(proof.root, root);
      assert.equal(verifyProof(proof), true, `proof invalid at n=${n} i=${i}`);
      assert.equal(refRootFromProof(leaves[i], i, proof.path), root, `brute-force mismatch at n=${n} i=${i}`);
    }
  }
});

test('random challenges: proofs verify offline', () => {
  const leaves = randomLeaves(100);
  for (let k = 0; k < 25; k++) {
    const i = randomInt(0, leaves.length);
    const proof = merkleProof(leaves, i);
    assert.equal(verifyProof(proof), true);
  }
});

test('out-of-range challenge throws NO_PROOF', () => {
  const leaves = randomLeaves(4);
  assert.throws(() => merkleProof(leaves, 4), (err) => err.code === NO_PROOF);
  assert.throws(() => merkleProof(leaves, -1), (err) => err.code === NO_PROOF);
  assert.throws(() => merkleProof([], 0), (err) => err.code === NO_PROOF);
});

test('tampered proof fails verification', () => {
  const leaves = randomLeaves(8);
  const proof = merkleProof(leaves, 3);
  const bad = { ...proof, path: proof.path.map((s, i) => (i === 0 ? { ...s, hash: '0'.repeat(64) } : s)) };
  assert.equal(verifyProof(bad), false);
  const wrongLeaf = { ...proof, leafHash: leaves[4] };
  assert.equal(verifyProof(wrongLeaf), false);
});
