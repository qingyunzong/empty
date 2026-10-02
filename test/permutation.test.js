'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');
const { referenceRun } = require('../src/reference');

function* permutations(items) {
  if (items.length <= 1) {
    yield items;
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const perm of permutations(rest)) yield [items[i], ...perm];
  }
}

const FRAMES = [
  { authId: 'P', type: 'hold', seq: 1, amount: 1000, limit: 5000, ts: 0 },
  { authId: 'P', type: 'inc', seq: 2, amount: 200, ts: 1 },
  { authId: 'P', type: 'dec', seq: 3, amount: 100, ts: 2 },
  { authId: 'P', type: 'inc', seq: 4, amount: 300, ts: 3 },
  { authId: 'P', type: 'dec', seq: 5, amount: 50, ts: 4 },
  { authId: 'P', type: 'complete', seq: 6, amount: 800, ts: 5 },
  { authId: 'P', type: 'reverse', seq: 7, amount: 100, ts: 6 },
];

test('acceptance 5: all 7! arrival orders converge to the reference state machine', () => {
  const reference = referenceRun(FRAMES, { ttl: 100000 });
  const refAuth = reference.auths.P;
  assert.deepEqual(
    { status: refAuth.status, frozen: refAuth.frozen, charged: refAuth.charged },
    { status: 'COMPLETED', frozen: 0, charged: 700 },
  );
  let count = 0;
  for (const perm of permutations(FRAMES)) {
    const engine = new Engine({ ttl: 100000 });
    for (const msg of perm) engine.ingest({ ...msg });
    const got = engine.report().auths.P;
    assert.deepEqual(
      { status: got.status, frozen: got.frozen, charged: got.charged },
      { status: refAuth.status, frozen: refAuth.frozen, charged: refAuth.charged },
      `divergence for order ${perm.map((m) => m.seq).join(',')}`,
    );
    count++;
  }
  assert.equal(count, 5040);
});

test('acceptance 5b: subsets of <=7 frames with duplicates also converge', () => {
  for (let size = 1; size <= FRAMES.length; size++) {
    const subset = FRAMES.slice(0, size);
    const reference = referenceRun(subset, { ttl: 100000 });
    const refAuth = reference.auths.P;
    for (const perm of permutations(subset)) {
      const withDup = [...perm.slice(0, 2), perm[1], ...perm.slice(2)];
      const engine = new Engine({ ttl: 100000 });
      for (const msg of withDup) engine.ingest({ ...msg });
      const got = engine.report().auths.P;
      assert.deepEqual(
        { status: got.status, frozen: got.frozen, charged: got.charged },
        { status: refAuth.status, frozen: refAuth.frozen, charged: refAuth.charged },
      );
    }
  }
});
