'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ledger = require('../src/ledger');
const { Store } = require('../src/store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'settle-recovery-'));
}

test('recovers index from the chunk chain after a crash', () => {
  const dir = tmpDir();
  ledger.propose(dir, {
    batchId: 'b1',
    transfers: [{ id: 't1', from: 'A', to: 'B', amount: 10 }],
    budgets: { A: 100 },
  });
  ledger.finalize(dir, { batchId: 'b1' });
  ledger.propose(dir, {
    batchId: 'b2',
    transfers: [{ id: 't2', from: 'B', to: 'C', amount: 5 }],
    budgets: { B: 100 },
  });
  ledger.finalize(dir, { batchId: 'b2' });

  // Simulate the crash: chunks persisted, level index lost.
  const store = new Store(dir);
  fs.unlinkSync(store.indexPath);
  assert.ok(!store.indexExists());

  // Recovery recomputes the result from the chunk chain.
  const loaded = ledger.load(dir);
  assert.ok(store.indexExists(), 'index rebuilt on load');
  const index = store.loadIndex();
  assert.equal(index.length, 2);
  assert.deepEqual(
    index.map((e) => e.level).sort(),
    [0, 1]
  );
  assert.equal(loaded.head().batchId, 'b2');
  const net = loaded.netPosition(loaded.chainTo(loaded.head().hash));
  assert.deepEqual(net, { A: 10, B: -5, C: -5 });
});

test('recovered store keeps incomplete references missing', () => {
  const dir = tmpDir();
  ledger.propose(dir, {
    batchId: 'b1',
    transfers: [{ id: 't1', from: 'A', to: 'B', amount: 10 }],
    budgets: { A: 100 },
  });
  ledger.finalize(dir, { batchId: 'b1' });

  // Crash after chunk persist, before index update: drop the index entirely,
  // and leave a dangling reference on disk (a chunk naming an absent parent).
  const store = new Store(dir);
  fs.unlinkSync(store.indexPath);
  const { buildChunk } = require('../src/store');
  const orphan = buildChunk({
    batchId: 'bZ',
    level: 1,
    parentHash: 'a'.repeat(64),
    dependsOn: ['a'.repeat(64)],
    corrects: null,
    transfers: ['ghost'],
    deltas: { A: { debit: 1, credit: 0, net: 1 } },
    budgets: {},
    seq: 50,
    index: [],
  });
  store.writeChunk(orphan);

  const loaded = ledger.load(dir);
  // b1 recovered from the chain; orphan stays missing, not settleable.
  assert.equal(loaded.head().batchId, 'b1');
  assert.equal(loaded.statusOf(orphan.hash), 'missing');
  assert.equal(loaded.findByBatch('bZ'), null);
});
