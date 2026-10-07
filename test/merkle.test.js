import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256hex, leafHash, merkleRoot } from '../src/merkle.js';

// Fully independent reference implementation used only by these tests.
const refHash = (s) => createHash('sha256').update(s).digest('hex');
const refCanonical = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(refCanonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + refCanonical(v[k])).join(',') + '}';
};
const refLeaf = (entry) => refHash('leaf:' + refCanonical(entry));
const refNode = (l, r) => refHash('node:' + l + r);

test('sha256 known empty-string vector', () => {
  assert.equal(
    sha256hex(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
});

test('empty tree root is the sha256 of the empty string', () => {
  assert.equal(merkleRoot([]), refHash(''));
});

test('single-leaf tree root equals the leaf hash', () => {
  const leaf = refLeaf({ type: 'record', id: 'r1' });
  assert.equal(merkleRoot([leaf]), leaf);
});

test('two-leaf tree matches independent pairwise hash', () => {
  const l1 = refLeaf({ type: 'record', id: 'r1' });
  const l2 = refLeaf({ type: 'tombstone', id: 'r2' });
  assert.equal(merkleRoot([l1, l2]), refNode(l1, l2));
});

test('three-leaf tree duplicates the odd leaf (small-scale tree hash)', () => {
  const l1 = refLeaf({ type: 'record', id: 'r1' });
  const l2 = refLeaf({ type: 'record', id: 'r2' });
  const l3 = refLeaf({ type: 'tombstone', id: 'r3' });
  const expected = refNode(refNode(l1, l2), refNode(l3, l3));
  assert.equal(merkleRoot([l1, l2, l3]), expected);
});

test('four-leaf balanced tree matches independent computation', () => {
  const ls = ['r1', 'r2', 'r3', 'r4'].map((id) => refLeaf({ type: 'record', id }));
  const expected = refNode(refNode(ls[0], ls[1]), refNode(ls[2], ls[3]));
  assert.equal(merkleRoot(ls), expected);
});

test('leafHash is key-order insensitive and domain separated', () => {
  const a = leafHash({ type: 'record', id: 'r1', amountA: 1, amountB: 2 });
  const b = leafHash({ id: 'r1', amountB: 2, amountA: 1, type: 'record' });
  assert.equal(a, b);
  assert.notEqual(a, sha256hex(refCanonical({ type: 'record', id: 'r1', amountA: 1, amountB: 2 })));
});

test('root is order sensitive and changes with any leaf change', () => {
  const l1 = refLeaf({ type: 'record', id: 'r1' });
  const l2 = refLeaf({ type: 'record', id: 'r2' });
  const l3 = refLeaf({ type: 'record', id: 'r3' });
  assert.notEqual(merkleRoot([l1, l2]), merkleRoot([l2, l1]));
  assert.notEqual(merkleRoot([l1, l2]), merkleRoot([l1, l3]));
});
