import test from 'node:test';
import assert from 'node:assert/strict';
import {leafHash, merkleRoot, inclusionProof, verifyInclusion} from '../src/merkle.js';

test('merkle root and inclusion proofs', () => {
  const entries = [
    {station: 'S1', window: 'W1', start: 0, end: 2},
    {station: 'S1', window: 'W2', start: 2, end: 4},
    {station: 'S2', window: 'W1', start: 0, end: 2},
  ];
  const leaves = entries.map(leafHash);
  const root = merkleRoot(leaves);
  assert.equal(root.length, 64);
  for (let i = 0; i < leaves.length; i++) {
    assert.ok(verifyInclusion(leaves[i], inclusionProof(leaves, i), root));
  }
  // Tampering with a leaf breaks verification.
  const bad = leafHash({station: 'S9', window: 'W9', start: 9, end: 10});
  assert.ok(!verifyInclusion(bad, inclusionProof(leaves, 0), root));
  // Root is order-sensitive and deterministic.
  assert.equal(merkleRoot(leaves), root);
  assert.notEqual(merkleRoot([...leaves].reverse()), root);
});
