import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePositions, decodePositions } from '../src/codec.js';

test('position block codec round-trips sorted position lists', () => {
  const cases = [
    [],
    [0],
    [5],
    [0, 1, 2, 3, 4],
    [3, 7, 128, 300, 100000],
    [0, 0 + 1, 127, 128, 129, 16383, 16384],
  ];
  // deterministic pseudo-random cases
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let c = 0; c < 20; c++) {
    const list = [];
    let pos = Math.floor(rand() * 5);
    for (let i = 0; i < 1 + Math.floor(rand() * 30); i++) {
      list.push(pos);
      pos += 1 + Math.floor(rand() * 200);
    }
    cases.push(list);
  }
  for (const positions of cases) {
    const block = encodePositions(positions);
    assert.ok(Buffer.isBuffer(block));
    assert.deepEqual(decodePositions(block), positions);
  }
});

test('codec rejects truncated blocks', () => {
  assert.throws(() => decodePositions(Buffer.from([0x80])), /truncated/);
});
