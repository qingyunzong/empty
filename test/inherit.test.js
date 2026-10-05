'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { effectiveAt, leafEffectiveThresholds } = require('../lib/tree');

// 3-level tree, 3 keys, 4 nodes: root -> a -> a1 ; root -> b.
const KEYS = ['k1', 'k2', 'k3'];
const NODE_PATHS = [[], ['a'], ['a', 'a1'], ['b']];

function buildTree(mask) {
  const thresholdsFor = (nodeIdx) => {
    const t = {};
    KEYS.forEach((key, keyIdx) => {
      if (mask & (1 << (nodeIdx * KEYS.length + keyIdx))) {
        t[key] = (nodeIdx + 1) * 10 + keyIdx;
      }
    });
    return t;
  };
  return {
    thresholds: thresholdsFor(0),
    children: {
      a: {
        thresholds: thresholdsFor(1),
        children: { a1: { thresholds: thresholdsFor(2), children: {} } },
      },
      b: { thresholds: thresholdsFor(3), children: {} },
    },
  };
}

// Independent reference implementation: collect overrides from the node up
// to the root, then apply root-first so the nearest ancestor wins per key.
function referenceEffective(tree, segs) {
  const chain = [];
  let node = tree;
  chain.push(node.thresholds || {});
  for (const seg of segs) {
    node = node.children[seg];
    chain.push(node.thresholds || {});
  }
  const effective = {};
  for (const thresholds of chain) Object.assign(effective, thresholds);
  return effective;
}

test('all override subsets (<=3 levels, <=3 keys) match independent inheritance', () => {
  const total = 1 << (NODE_PATHS.length * KEYS.length); // 2^12 = 4096
  for (let mask = 0; mask < total; mask++) {
    const tree = buildTree(mask);
    for (const segs of NODE_PATHS) {
      assert.deepEqual(effectiveAt(tree, segs), referenceEffective(tree, segs));
    }
    const leaves = leafEffectiveThresholds(tree);
    assert.deepEqual(leaves['/a/a1'], referenceEffective(tree, ['a', 'a1']));
    assert.deepEqual(leaves['/b'], referenceEffective(tree, ['b']));
    assert.equal(Object.keys(leaves).length, 2);
  }
});

test('nearest ancestor wins, unset keys fall through', () => {
  const tree = {
    thresholds: { temp: 1, hum: 2, press: 3 },
    children: {
      x: {
        thresholds: { temp: 10 },
        children: { y: { thresholds: { hum: 20 }, children: {} } },
      },
    },
  };
  assert.deepEqual(effectiveAt(tree, ['x', 'y']), { temp: 10, hum: 20, press: 3 });
});
