import test from 'node:test';
import assert from 'node:assert/strict';
import { randomInt, randomBytes } from 'node:crypto';
import { merkleRoot, prove, verifyProof } from '../src/merkle.js';
import { refMerkleRoot } from '../testing/reference.js';

function randomHashes(n) {
  return Array.from({ length: n }, () => randomBytes(32).toString('hex'));
}

test('acceptance 1: random small trees match brute-force Merkle reference', () => {
  for (let iter = 0; iter < 200; iter++) {
    const n = randomInt(1, 65);
    const hashes = randomHashes(n);
    assert.equal(merkleRoot(hashes), refMerkleRoot(hashes), `root mismatch at n=${n}`);
  }
});

test('acceptance 1: inclusion proofs verify for every index of random trees', () => {
  for (let iter = 0; iter < 100; iter++) {
    const n = randomInt(1, 40);
    const hashes = randomHashes(n);
    const root = merkleRoot(hashes);
    for (let i = 0; i < n; i++) {
      const proof = prove(hashes, i);
      assert.ok(verifyProof(hashes[i], i, n, proof, root), `proof failed n=${n} i=${i}`);
      // wrong index must fail
      const j = (i + 1) % n;
      if (j !== i) assert.equal(verifyProof(hashes[i], j, n, proof, root), false);
      // tampered sibling must fail
      if (proof.length > 0) {
        const bad = proof.map((s, k) => (k === 0 ? { ...s, hash: randomBytes(32).toString('hex') } : s));
        assert.equal(verifyProof(hashes[i], i, n, bad, root), false);
      }
      // tampered leaf must fail
      assert.equal(verifyProof(randomBytes(32).toString('hex'), i, n, proof, root), false);
    }
  }
});

test('empty tree has deterministic domain-separated root', () => {
  assert.equal(merkleRoot([]), merkleRoot([]));
  assert.notEqual(merkleRoot([]), merkleRoot(randomHashes(1)));
});
