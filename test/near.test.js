import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildForest,
  buildPositionalIndex,
  enumerateOrderedWindows,
  findNearHits,
  subtreeIds,
} from '../src/core.js';
import { genTree, makeRng } from '../support/helpers.js';

test('index hits match brute-force ordered-window enumeration', () => {
  const vocab = ['alpha', 'beta', 'gamma', 'delta'];
  const phrases = [
    ['alpha', 'beta'],
    ['beta', 'beta'],
    ['gamma', 'delta'],
    ['delta', 'alpha'],
  ];
  for (let seed = 1; seed <= 25; seed++) {
    const rng = makeRng(seed);
    const nodes = genTree(rng, { count: 15, vocab });
    const index = buildPositionalIndex(nodes);
    const { childrenOf } = buildForest(nodes);
    for (const rootId of ['n000', 'n003', 'n007']) {
      const scope = subtreeIds(childrenOf, rootId);
      for (const slop of [0, 1, 2, 3]) {
        for (const phrase of phrases) {
          const hits = findNearHits(index, scope, phrase, slop);
          const expected = [];
          for (const node of nodes) {
            if (!scope.has(node.id)) continue;
            const pairs = enumerateOrderedWindows(node.reason, phrase, slop);
            if (pairs.length > 0) expected.push({ nodeId: node.id, positions: pairs });
          }
          expected.sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1));
          assert.deepEqual(
            hits,
            expected,
            `mismatch seed=${seed} root=${rootId} slop=${slop} phrase=${phrase.join(' ')}`,
          );
        }
      }
    }
  }
});

test('slop semantics: adjacency, gaps, order, repeated terms', () => {
  assert.deepEqual(enumerateOrderedWindows('pay refund now', ['pay', 'refund'], 0), [[0, 1]]);
  assert.deepEqual(enumerateOrderedWindows('pay now refund', ['pay', 'refund'], 0), []);
  assert.deepEqual(enumerateOrderedWindows('pay now refund', ['pay', 'refund'], 1), [[0, 2]]);
  assert.deepEqual(enumerateOrderedWindows('pay x y refund', ['pay', 'refund'], 1), []);
  assert.deepEqual(enumerateOrderedWindows('pay x y refund', ['pay', 'refund'], 2), [[0, 3]]);
  assert.deepEqual(enumerateOrderedWindows('refund pay', ['pay', 'refund'], 10), []);
  assert.deepEqual(enumerateOrderedWindows('foo a foo b foo', ['foo', 'foo'], 0), []);
  assert.deepEqual(enumerateOrderedWindows('foo a foo b foo', ['foo', 'foo'], 1), [
    [0, 2],
    [2, 4],
  ]);
  assert.deepEqual(enumerateOrderedWindows('Pay NOW Refund', ['pay', 'refund'], 1), [[0, 2]]);
  assert.deepEqual(enumerateOrderedWindows('', ['pay', 'refund'], 5), []);
});
