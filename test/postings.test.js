import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePostings, PostingsCursor } from '../src/postings.js';

function makeEntries() {
  const entries = [];
  for (let docId = 1; docId <= 10; docId += 1) {
    const positions = [];
    for (let p = 0; p < docId; p += 1) positions.push(p * 3 + 1);
    entries.push({ docId, positions });
  }
  return entries;
}

test('block headers carry maxDocId and position base', () => {
  const entries = makeEntries();
  const { blocks } = encodePostings(entries, 4);
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks.map((b) => b.maxDocId), [4, 8, 10]);
  // position base = cumulative position count of preceding blocks
  assert.equal(blocks[0].posBase, 0);
  assert.equal(blocks[1].posBase, 1 + 2 + 3 + 4);
  assert.equal(blocks[2].posBase, 1 + 2 + 3 + 4 + 5 + 6 + 7 + 8);
});

test('cursor iterates all entries in order', () => {
  const entries = makeEntries();
  const { data, blocks } = encodePostings(entries, 4);
  const cursor = new PostingsCursor(data, blocks);
  const got = [];
  let e;
  while ((e = cursor.next())) got.push(e);
  assert.deepEqual(got, entries);
});

test('advance skips blocks via header without losing correctness', () => {
  const entries = makeEntries();
  const { data, blocks } = encodePostings(entries, 4);
  const cursor = new PostingsCursor(data, blocks);
  const hit = cursor.advance(5);
  assert.equal(hit.docId, 5);
  assert.equal(cursor.blockIndex, 1); // block 0 skipped, never decoded
  assert.deepEqual(cursor.next().docId, 6);
  assert.equal(cursor.advance(8).docId, 8);
  assert.equal(cursor.advance(9).docId, 9); // skips remainder of block 1
  assert.equal(cursor.advance(11), null);
});

test('advance never moves backward', () => {
  const { data, blocks } = encodePostings(makeEntries(), 4);
  const cursor = new PostingsCursor(data, blocks);
  assert.equal(cursor.advance(7).docId, 7);
  assert.equal(cursor.advance(3).docId, 7); // stays at current entry
});

test('empty postings encode to zero blocks', () => {
  const { data, blocks } = encodePostings([], 4);
  assert.equal(data.length, 0);
  assert.deepEqual(blocks, []);
  assert.equal(new PostingsCursor(data, blocks).next(), null);
});
