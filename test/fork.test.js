'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Ledger } = require('../lib/ledger');
const { Store } = require('../lib/store');

const BASE = { alice: { credit: 10000 }, bob: { position: 500 } };

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txlog-fork-'));
  return path.join(dir, 'log.bin');
}

function setupChain(file) {
  const ledger = new Ledger(file, BASE);
  ledger.put({ txId: 'tx1', buyer: 'alice', seller: 'bob', qty: 2, price: 10 });
  ledger.put({ txId: 'tx2', buyer: 'alice', seller: 'bob', qty: 3, price: 10 });
  return ledger;
}

test('fork: same prevHash with different seq is rejected with code=FORK, no state update', () => {
  const file = tmpFile();
  const ledger = setupChain(file);
  const store = ledger.store;
  const block1 = store.blocks[0];

  const sizeBefore = fs.statSync(file).size;
  const blocksBefore = store.blocks.length;
  const stateBefore = ledger.replay().state;

  // A competing chain extended block1 directly with seq 3 (skipping our seq 2).
  assert.throws(
    () => store.commitBlock({
      seq: 3,
      prevHash: block1.hash.toString('hex'),
      records: [{ op: 'put', txId: 'txX', buyer: 'alice', seller: 'bob', qty: 9, price: 1 }],
    }),
    (err) => err.code === 'FORK'
  );

  // No automatic chain selection, no state update.
  assert.equal(fs.statSync(file).size, sizeBefore);
  assert.equal(store.blocks.length, blocksBefore);
  assert.deepEqual(ledger.replay().state, stateBefore);

  // The honest chain keeps working after the rejected fork attempt.
  ledger.put({ txId: 'tx3', buyer: 'alice', seller: 'bob', qty: 1, price: 1 });
  assert.equal(ledger.replay().blocks, 3);
});

test('fork: same prevHash and same seq but different content is also a fork', () => {
  const file = tmpFile();
  const ledger = setupChain(file);
  const store = ledger.store;
  const block1 = store.blocks[0];

  const sizeBefore = fs.statSync(file).size;
  assert.throws(
    () => store.commitBlock({
      seq: 2,
      prevHash: block1.hash.toString('hex'),
      records: [{ op: 'put', txId: 'txEvil', buyer: 'alice', seller: 'bob', qty: 99, price: 1 }],
    }),
    (err) => err.code === 'FORK'
  );
  assert.equal(fs.statSync(file).size, sizeBefore);
  assert.equal(store.blocks.length, 2);
});

test('fork: competing chain built from a shared prefix is rejected on merge', () => {
  const fileA = tmpFile();
  const fileB = tmpFile();
  const a = new Ledger(fileA, BASE);
  a.put({ txId: 'tx1', buyer: 'alice', seller: 'bob', qty: 2, price: 10 });

  // Chain B replicates block 1 exactly, then diverges.
  const b = new Store(fileB);
  const shared = a.store.blocks[0];
  b.commitBlock({ seq: shared.seq, prevHash: shared.prevHash.toString('hex'), records: shared.records });
  b.commitBlock({
    seq: 2,
    prevHash: b.tipHash.toString('hex'),
    records: [{ op: 'put', txId: 'txB', buyer: 'alice', seller: 'bob', qty: 7, price: 1 }],
  });

  // A continues its own chain.
  a.put({ txId: 'tx2', buyer: 'alice', seller: 'bob', qty: 3, price: 10 });

  // Merging B's divergent block into A must be detected as a fork.
  const divergent = b.blocks[1];
  assert.throws(
    () => a.store.commitBlock({ seq: divergent.seq, prevHash: divergent.prevHash.toString('hex'), records: divergent.records }),
    (err) => err.code === 'FORK'
  );
  assert.equal(a.store.blocks.length, 2);
  assert.deepEqual(Object.keys(a.replay().state.txs).sort(), ['tx1', 'tx2']);
});
