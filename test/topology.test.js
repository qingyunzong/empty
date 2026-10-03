'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collector } = require('../lib/collector');
const { referenceBalances } = require('../lib/refledger');
const { ev, permutations, shuffled, mulberry32 } = require('./helpers');

// Acceptance 5: for <= 10 events, enumerate legal delivery topologies
// (permutations of the arrival order) and check every one against an
// independent reference ledger. Balances and the Merkle root must be
// identical no matter how the events were shuffled in transit.
function runOrder(events) {
  const c = new Collector({ gapWindow: 64 });
  for (const e of events) c.register(e);
  const p = c.close();
  return {
    balances: Object.fromEntries([...c.balances.entries()].sort()),
    merkleRoot: p.merkleRoot,
    order: p.events,
  };
}

function makeEvents() {
  return [
    ev('a1', 'A', 100, 1, 1),
    ev('a2', 'A', -30, 2, 2),
    ev('a3', 'A', 0, 3, 3, { reversalOf: 'a1' }),
    ev('a4', 'A', 60, 4, 4, { replaces: 'a1' }),
    ev('b1', 'B', 50, 1, 5),
    ev('b2', 'B', 0, 2, 6, { reversalOf: 'b1' }),
    ev('b3', 'B', 25, 3, 7, { replaces: 'b1' }),
    ev('c1', 'C', 8, 1, 8),
    ev('c2', 'C', 9, 2, 9),
    ev('c3', 'C', 10, 3, 10),
  ];
}

test('exhaustive permutations of 6 events match the reference ledger', () => {
  const events = makeEvents().slice(0, 6);
  const want = referenceBalances(events);
  let canonicalRoot = null;
  let count = 0;
  for (const order of permutations(events)) {
    const r = runOrder(order);
    assert.deepEqual(r.balances, want);
    if (canonicalRoot === null) canonicalRoot = r.merkleRoot;
    assert.equal(r.merkleRoot, canonicalRoot, 'merkle root must not depend on delivery order');
    count++;
  }
  assert.equal(count, 720);
});

test('sampled topologies for 8 and 10 events match the reference ledger', () => {
  const rand = mulberry32(20261004);
  for (const n of [8, 10]) {
    const events = makeEvents().slice(0, n);
    const want = referenceBalances(events);
    const canonical = runOrder(events);
    for (let i = 0; i < 300; i++) {
      const r = runOrder(shuffled(events, rand));
      assert.deepEqual(r.balances, want, `n=${n} iteration=${i}`);
      assert.equal(r.merkleRoot, canonical.merkleRoot);
      assert.deepEqual(r.order, canonical.order, 'canonical order must not depend on delivery order');
    }
  }
});

test('reference ledger sanity: correction chain folds correctly', () => {
  const events = makeEvents();
  const balances = referenceBalances(events);
  assert.equal(balances.A, 30); // 100 - 30 - 100 + 60
  assert.equal(balances.B, 25);
  assert.equal(balances.C, 27);
});
