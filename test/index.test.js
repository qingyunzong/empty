import test from 'node:test';
import assert from 'node:assert/strict';
import { PositionalIndex } from '../src/index.js';
import { mulberry32, bruteForceNear, randomReason } from '../testing/helpers.js';

test('ordered near: basic match, order and slop boundaries', () => {
  const nodes = [
    { id: 'a', reason: 'foo bar' },          // gap 0
    { id: 'b', reason: 'foo x y bar' },      // gap 2
    { id: 'c', reason: 'foo x y z bar' },    // gap 3
    { id: 'd', reason: 'bar foo' },          // wrong order
    { id: 'e', reason: 'unrelated text' },
  ];
  const index = PositionalIndex.fromNodes(nodes);

  assert.deepEqual([...index.near('foo', 'bar', 0).keys()], ['a']);
  assert.deepEqual([...index.near('foo', 'bar', 2).keys()].sort(), ['a', 'b']);
  assert.deepEqual([...index.near('foo', 'bar', 3).keys()].sort(), ['a', 'b', 'c']);
  assert.deepEqual([...index.near('bar', 'foo', 5).keys()], ['d']);
  assert.equal(index.near('foo', 'missing', 9).size, 0);
});

test('ordered near: all matching position pairs are reported', () => {
  const nodes = [{ id: 'n', reason: 'foo x foo y bar bar' }];
  const index = PositionalIndex.fromNodes(nodes);
  const hits = index.near('foo', 'bar', 3);
  assert.deepEqual(hits.get('n'), [[0, 4], [2, 4], [2, 5]]);
});

test('ordered near: repeated identical terms require strict order', () => {
  const nodes = [{ id: 'n', reason: 'foo foo foo' }];
  const index = PositionalIndex.fromNodes(nodes);
  assert.deepEqual(index.near('foo', 'foo', 0).get('n'), [[0, 1], [1, 2]]);
  assert.deepEqual(index.near('foo', 'foo', 1).get('n'), [[0, 1], [0, 2], [1, 2]]);
});

test('acceptance 1: index matches brute-force enumeration of ordered windows', () => {
  const vocab = ['alpha', 'beta', 'gamma', 'delta', 'foo', 'bar'];
  const rand = mulberry32(20261003);
  for (let round = 0; round < 200; round++) {
    const count = 1 + Math.floor(rand() * 12);
    const nodes = [];
    for (let i = 0; i < count; i++) {
      nodes.push({ id: `n${i}`, reason: randomReason(rand, vocab, 8) });
    }
    const first = vocab[Math.floor(rand() * vocab.length)];
    const second = vocab[Math.floor(rand() * vocab.length)];
    const slop = Math.floor(rand() * 4);
    const index = PositionalIndex.fromNodes(nodes);
    const expected = bruteForceNear(nodes, first, second, slop);
    const actual = index.near(first, second, slop);
    assert.deepEqual(
      [...actual.keys()].sort(),
      [...expected.keys()].sort(),
      `round ${round}: hit ids diverge for (${first}, ${second}, slop=${slop})`,
    );
    for (const [id, pairs] of expected) {
      assert.deepEqual(actual.get(id), pairs, `round ${round}: positions diverge for ${id}`);
    }
  }
});
