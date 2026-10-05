import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePostings, decodePostings, BLOCK_SIZE } from '../src/index.js';

test('block-compressed postings round-trip with skip-list seeks', () => {
  const positions = [];
  let p = 0;
  for (let i = 0; i < BLOCK_SIZE * 3 + 5; i++) {
    p += 1 + (i % 4);
    positions.push(p);
  }
  const enc = encodePostings(positions);
  assert.equal(enc.blocks.length, 4, 'posts split into blocks');
  assert.equal(enc.skip.length, 4);
  assert.deepEqual(decodePostings(enc), positions);
  // seek using the skip list: only positions >= minPos survive
  for (const cut of [positions[0], positions[BLOCK_SIZE], positions[BLOCK_SIZE * 2], positions[positions.length - 1]]) {
    assert.deepEqual(decodePostings(enc, cut), positions.filter((x) => x >= cut));
  }
  assert.deepEqual(decodePostings(enc, positions[positions.length - 1] + 1), []);
});
