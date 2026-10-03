import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runPack } from '../src/pack.js';
import { PackError } from '../src/errors.js';
import { tmpDir, writeInput } from './helpers.js';

const BAD_HASHES = [
  'abc', // too short
  'A'.repeat(64), // uppercase
  'g'.repeat(64), // non-hex
  'f'.repeat(63), // 63 chars
  'f'.repeat(65), // 65 chars
  12345, // not a string
];

test('HASH_BAD: non 64-char lowercase hex hashes are rejected', () => {
  for (const hash of BAD_HASHES) {
    const root = tmpDir();
    const inDir = writeInput(path.join(root, 'in'), {
      'vision.jsonl': [{ eventTs: 1000, frame: 1, sku: 'S1', defect: 'dent', hash, op: 'v1' }],
    });
    assert.throws(
      () => runPack(inDir, path.join(root, 'out')),
      (err) => err instanceof PackError && err.code === 'HASH_BAD',
      `hash ${JSON.stringify(hash)} must raise HASH_BAD`,
    );
  }
});

test('HASH_BAD: a valid 64-char lowercase hex hash is accepted', () => {
  const root = tmpDir();
  const inDir = writeInput(path.join(root, 'in'), {
    'barcode.jsonl': [{ eventTs: 1000, frame: 1, case: 'C1', op: 'b1' }],
    'vision.jsonl': [{ eventTs: 1001, frame: 1, sku: 'S1', defect: null, hash: '0123456789abcdef'.repeat(4), op: 'v1' }],
    'audit.jsonl': [{ eventTs: 1002, sku: 'S1', pass: true, op: 'a1' }],
  });
  const { release } = runPack(inDir, path.join(root, 'out'));
  assert.deepEqual(release.released, ['C1']);
});
