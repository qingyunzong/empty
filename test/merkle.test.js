import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CustodyChain } from '../src/chain.js';
import { CODES } from '../src/errors.js';
import { tmpStore, readLines, cleanup } from '../support/helpers.js';

// Independent brute-force reference: recompute everything straight from the
// raw JSONL file, with no shared library code for hashing or tree building.
function refSha(data) {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}
function refCanonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(refCanonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + refCanonical(v[k])).join(',') + '}';
}
function refRootFromFile(dir) {
  const lines = readLines(dir);
  const leaves = lines.map((line) => {
    const ev = JSON.parse(line);
    const { hash, ...rest } = ev;
    const recomputed = refSha(refCanonical(rest));
    assert.equal(recomputed, hash, 'event hash must match brute-force recompute');
    return refSha('leaf:' + hash);
  });
  let level = leaves;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const r = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(refSha('node:' + level[i] + r));
    }
    level = next;
  }
  return { root: level[0], leaves };
}
function refVerifyPath(leaf, path, root) {
  let acc = leaf;
  for (const step of path) {
    acc = step.side === 'left' ? refSha('node:' + step.hash + acc) : refSha('node:' + acc + step.hash);
  }
  return acc === root;
}

test('proofs match brute-force recomputation for many chain sizes and indices', () => {
  const dir = tmpStore();
  try {
    const chain = CustodyChain.open(dir);
    for (let n = 1; n <= 40; n++) {
      chain.appendEvent({ type: 'receive', actor: 'a', sampleId: 'S' + n, consentId: 'C' + n });
      const ref = refRootFromFile(dir);
      const indices = n === 1 ? [0] : [0, n - 1, randomInt(n)];
      for (const idx of indices) {
        const proof = chain.challenge(idx);
        assert.equal(proof.root, ref.root, `root mismatch at n=${n}`);
        assert.equal(proof.leaf, ref.leaves[idx], `leaf mismatch at n=${n} idx=${idx}`);
        assert.equal(CustodyChain.verifyProof(proof), true);
        assert.equal(refVerifyPath(proof.leaf, proof.path, proof.root), true);
        // Path length is ceil(log2(n)).
        assert.equal(proof.path.length, n <= 1 ? 0 : Math.ceil(Math.log2(n)));
      }
    }
  } finally {
    cleanup(dir);
  }
});

test('corrupted proofs fail verification', () => {
  const dir = tmpStore();
  try {
    const chain = CustodyChain.open(dir);
    for (let i = 0; i < 7; i++) {
      chain.appendEvent({ type: 'analyze', actor: 'a', sampleId: 'S' + i, consentId: 'C' + i });
    }
    const proof = chain.challenge(3);
    const badLeaf = { ...proof, leaf: '0'.repeat(64) };
    assert.equal(CustodyChain.verifyProof(badLeaf), false);
    const badPath = { ...proof, path: proof.path.map((s, i) => (i === 0 ? { ...s, hash: 'f'.repeat(64) } : s)) };
    assert.equal(CustodyChain.verifyProof(badPath), false);
    const badRoot = { ...proof, root: 'e'.repeat(64) };
    assert.equal(CustodyChain.verifyProof(badRoot), false);
  } finally {
    cleanup(dir);
  }
});

test('challenge errors: empty chain and out-of-range index give NO_PROOF', () => {
  const dir = tmpStore();
  try {
    const chain = CustodyChain.open(dir);
    assert.throws(() => chain.challenge(), (err) => err.code === CODES.NO_PROOF);
    chain.appendEvent({ type: 'receive', actor: 'a', sampleId: 'S', consentId: 'C' });
    assert.throws(() => chain.challenge(1), (err) => err.code === CODES.NO_PROOF);
    assert.throws(() => chain.challenge(-1), (err) => err.code === CODES.NO_PROOF);
    const p = chain.challenge(0);
    assert.equal(p.index, 0);
    assert.equal(p.path.length, 0);
  } finally {
    cleanup(dir);
  }
});
