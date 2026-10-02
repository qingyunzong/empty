import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evpack-test-'));
}

// Deterministic PRNG (mulberry32) so "random" tests are reproducible.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomPayload(rand) {
  const kinds = ['int', 'str', 'obj', 'arr'];
  switch (kinds[Math.floor(rand() * kinds.length)]) {
    case 'int': return { value: Math.floor(rand() * 1e9) };
    case 'str': return { note: 'x'.repeat(1 + Math.floor(rand() * 40)) + Math.floor(rand() * 1e6) };
    case 'obj': return { a: Math.floor(rand() * 100), b: { c: rand() < 0.5, d: String(rand()) } };
    default: return [Math.floor(rand() * 10), { z: String(rand()) }, rand() < 0.5];
  }
}

// ---- Independent brute-force reference implementations ----
// Written separately from src/ on purpose: the tests cross-check the library
// against these direct recomputations.

const refHash = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

function refCanonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(refCanonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + refCanonical(v[k])).join(',') + '}';
}

export function refBlockHash(block) {
  return refHash(refCanonical({
    index: block.index, epoch: block.epoch, prev: block.prev, kind: block.kind, payload: block.payload,
  }));
}

// Recursive reference Merkle root (divide-and-conquer shape differs from the
// iterative library version but must agree on the odd-duplication rule).
export function refMerkleRoot(blockHashes) {
  if (blockHashes.length === 0) return refHash('evpack:empty');
  const leaves = blockHashes.map((h) => refHash('evpack:leaf:' + h));
  function build(level) {
    if (level.length === 1) return level[0];
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i];
      const r = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(refHash('evpack:node:' + l + ':' + r));
    }
    return build(next);
  }
  return refHash('evpack:root:' + blockHashes.length + ':' + build(leaves));
}

// Brute-force chain walk over the on-disk block files.
export function refWalkChain(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8'));
  const hashes = [];
  let prev = '0'.repeat(64);
  for (let i = 0; i < manifest.count; i += 1) {
    const file = path.join(dir, 'blocks', String(i).padStart(6, '0') + '.json');
    const block = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (block.prev !== prev) throw new Error(`ref: chain broken at ${i}`);
    const h = refBlockHash(block);
    if (h !== block.hash) throw new Error(`ref: hash mismatch at ${i}`);
    hashes.push(h);
    prev = h;
  }
  return { manifest, hashes, root: refMerkleRoot(hashes) };
}
