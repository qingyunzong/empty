'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const wip = require('../src/index.js');
const { tmpDir, cleanup } = require('./helpers.js');

function nodeWith(nodeId, ops) {
  const dir = tmpDir();
  const store = new wip.Store(dir);
  wip.begin(store, { session: `S-${nodeId}`, node: nodeId });
  for (const op of ops) {
    if (op.delta > 0) wip.scan(store, { session: `S-${nodeId}`, bin: op.bin, item: op.item, qty: op.delta });
    else wip.adjust(store, { session: `S-${nodeId}`, bin: op.bin, item: op.item, delta: op.delta });
  }
  wip.close(store, { session: `S-${nodeId}` });
  return { dir, store };
}

function consume(store, session, bin, item, delta) {
  wip.begin(store, { session });
  wip.adjust(store, { session, bin, item, delta });
  wip.close(store, { session });
}

test('three terminals converge bidirectionally; concurrent adjusts commute', () => {
  const a = nodeWith('A', [{ bin: 'A-01', item: 'ITM-0001', delta: 10 }]);
  const b = nodeWith('B', [{ bin: 'A-01', item: 'ITM-0001', delta: 5 }]);
  const c = nodeWith('C', []);
  try {
    wip.sync(a.store, b.store);
    wip.sync(b.store, c.store); // C learns the stock, then consumes 3 offline
    consume(c.store, 'S2', 'A-01', 'ITM-0001', -3);
    wip.sync(a.store, c.store);
    wip.sync(b.store, c.store); // second round so B learns C's op
    for (const n of [a, b, c]) {
      const s = n.store.loadState();
      assert.equal(s.inventory['A-01|ITM-0001'], 12);
      assert.deepEqual(s.vv, { A: 1, B: 1, C: 1 });
      assert.equal(s.pending.length, 0);
      assert.equal(wip.verify(n.store).ok, true);
    }
  } finally { [a, b, c].forEach((n) => cleanup(n.dir)); }
});

test('merge that would go negative parks in pending instead of failing, resolves later', () => {
  // Both terminals start from a synced stock of 4.
  const a = nodeWith('A', [{ bin: 'B-02', item: 'WIP-1000', delta: 4 }]);
  const b = nodeWith('B', []);
  try {
    wip.sync(a.store, b.store);
    // Offline divergence: A consumes 4 (local 0), B consumes 1 (local 3).
    consume(a.store, 'S2', 'B-02', 'WIP-1000', -4);
    consume(b.store, 'S2', 'B-02', 'WIP-1000', -1);

    // Merge: applying the peer's consume would go negative on both sides -> pending, not failure.
    const res = wip.sync(a.store, b.store);
    assert.equal(res.pending.A, 1);
    assert.equal(res.pending.B, 1);
    assert.equal(a.store.loadState().inventory['B-02|WIP-1000'], 0);
    assert.equal(b.store.loadState().inventory['B-02|WIP-1000'], 3);
    assert.equal(wip.verify(a.store).ok, true); // divergence is explainable, verify passes

    // C delivers +4; after syncing, the parked consumes become applicable everywhere.
    const c = nodeWith('C', [{ bin: 'B-02', item: 'WIP-1000', delta: 4 }]);
    try {
      wip.sync(a.store, c.store);
      assert.equal(a.store.loadState().pending.length, 0);
      assert.equal(a.store.loadState().inventory['B-02|WIP-1000'], 3); // 4-4+4-1
      wip.sync(a.store, b.store);
      assert.equal(b.store.loadState().pending.length, 0);
      assert.equal(b.store.loadState().inventory['B-02|WIP-1000'], 3);
      assert.equal(wip.verify(a.store).ok, true);
      assert.equal(wip.verify(b.store).ok, true);
    } finally { cleanup(c.dir); }
  } finally { cleanup(a.dir); cleanup(b.dir); }
});

test('sync is idempotent and version vectors dedupe ops', () => {
  const a = nodeWith('A', [{ bin: 'A-01', item: 'ITM-0001', delta: 3 }]);
  const b = nodeWith('B', [{ bin: 'A-01', item: 'ITM-0001', delta: 2 }]);
  try {
    wip.sync(a.store, b.store);
    const once = a.store.loadState().inventory['A-01|ITM-0001'];
    wip.sync(a.store, b.store);
    wip.sync(a.store, b.store);
    assert.equal(a.store.loadState().inventory['A-01|ITM-0001'], once);
    assert.equal(a.store.loadState().ops.length, 2);
    assert.equal(b.store.loadState().ops.length, 2);
  } finally { cleanup(a.dir); cleanup(b.dir); }
});
