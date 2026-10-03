import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodePostings, decodeBlock, PostingCursor, BLOCK_SIZE } from '../src/postings.js';
import { rng } from '../test-helpers/helpers.js';

function roundtrip(entries) {
  const blocks = encodePostings(entries);
  const out = [];
  for (const b of blocks) out.push(...decodeBlock(b));
  return out;
}

test('block encode/decode roundtrip', () => {
  const rand = rng(5);
  const entries = [];
  let doc = 1;
  for (let i = 0; i < 200; i++) {
    doc += Math.floor(rand() * 3);
    entries.push({ doc, pos: Math.floor(rand() * 500), para: Math.floor(rand() * 4) });
  }
  entries.sort((a, b) => a.doc - b.doc || a.pos - b.pos);
  assert.deepEqual(roundtrip(entries), entries);
});

test('block header stores maxDoc and posBase', () => {
  const entries = Array.from({ length: BLOCK_SIZE }, (_, i) => ({ doc: 10 + i, pos: 100 + i * 7, para: 0 }));
  const [block] = encodePostings(entries);
  assert.equal(block.maxDoc, 10 + BLOCK_SIZE - 1);
  assert.equal(block.posBase, 100);
});

test('seekDoc skips blocks without decoding them', () => {
  const entries = [];
  for (let d = 1; d <= 1000; d++) entries.push({ doc: d, pos: d, para: 0 });
  const blocks = encodePostings(entries);
  const cursor = new PostingCursor({ blocks, tail: [] });
  const hit = cursor.seekDoc(990);
  assert.equal(hit.doc, 990);
  // 125 blocks total; seeking near the end must decode far fewer blocks.
  assert.ok(cursor.blocksDecoded <= 3, `decoded ${cursor.blocksDecoded} blocks`);
});

test('seekDoc past the end returns null', () => {
  const blocks = encodePostings([{ doc: 1, pos: 0, para: 0 }]);
  const cursor = new PostingCursor({ blocks, tail: [] });
  assert.equal(cursor.seekDoc(99), null);
});
