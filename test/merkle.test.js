import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { merkleRoot, merkleProof, verifyMerkleProof, EMPTY_ROOT } from '../src/merkle.js';
import { rng, refMerkleRoot } from './helpers.js';

const randHash = (rand) => createHash('sha256').update(String(rand())).digest('hex');

test('empty tree root is the defined constant', () => {
  assert.equal(merkleRoot([]), EMPTY_ROOT);
  assert.equal(merkleRoot([]), refMerkleRoot([]));
});

test('random small trees match brute-force reference root', () => {
  const rand = rng(12345);
  for (let trial = 0; trial < 200; trial += 1) {
    const n = 1 + Math.floor(rand() * 17); // 1..17 leaves
    const leaves = Array.from({ length: n }, () => randHash(rand));
    assert.equal(merkleRoot(leaves), refMerkleRoot(leaves), `root mismatch at n=${n}`);
  }
});

test('every leaf of random trees has a valid inclusion proof', () => {
  const rand = rng(999);
  for (let trial = 0; trial < 100; trial += 1) {
    const n = 1 + Math.floor(rand() * 24);
    const leaves = Array.from({ length: n }, () => randHash(rand));
    const root = merkleRoot(leaves);
    for (let i = 0; i < n; i += 1) {
      const proof = merkleProof(leaves, i);
      assert.ok(verifyMerkleProof({ blockHash: leaves[i], index: i, count: n, proof, root }),
        `proof failed at n=${n} i=${i}`);
    }
  }
});

test('flipping one byte anywhere in a proof or leaf invalidates it', () => {
  const rand = rng(7);
  const n = 9;
  const leaves = Array.from({ length: n }, () => randHash(rand));
  const root = merkleRoot(leaves);
  for (let i = 0; i < n; i += 1) {
    const proof = merkleProof(leaves, i);
    // flip one hex char in the leaf
    const badLeaf = leaves[i].slice(0, 10) + (leaves[i][10] === 'a' ? 'b' : 'a') + leaves[i].slice(11);
    assert.equal(verifyMerkleProof({ blockHash: badLeaf, index: i, count: n, proof, root }), false);
    // flip one hex char in each proof step
    for (let s = 0; s < proof.length; s += 1) {
      const flip = (h) => (h[0] === 'f' ? 'e' : 'f') + h.slice(1);
      const bad = proof.map((p, j) => j === s
        ? { hash: flip(p.hash), side: p.side }
        : p);
      assert.equal(verifyMerkleProof({ blockHash: leaves[i], index: i, count: n, proof: bad, root }), false);
    }
    // wrong index / wrong count / truncated proof / wrong root
    assert.equal(verifyMerkleProof({ blockHash: leaves[i], index: (i + 1) % n, count: n, proof, root }), false);
    assert.equal(verifyMerkleProof({ blockHash: leaves[i], index: i, count: n + 1, proof, root }), false);
    assert.equal(verifyMerkleProof({ blockHash: leaves[i], index: i, count: n, proof: proof.slice(1), root }), false);
    assert.equal(verifyMerkleProof({ blockHash: leaves[i], index: i, count: n, proof, root: randHash(rand) }), false);
  }
});
