'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Ledger } = require('../lib/ledger');
const { INDEX_SPAN } = require('../lib/store');

const BASE = { alice: { credit: 100000 }, bob: { position: 1000 } };

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txlog-range-'));
  return path.join(dir, 'log.bin');
}

function buildChain(file, n = 20) {
  const ledger = new Ledger(file, BASE);
  for (let i = 1; i <= n; i++) {
    ledger.put({ txId: `tx${i}`, buyer: 'alice', seller: 'bob', qty: 1, price: 10 });
  }
  return ledger;
}

test('range decodes only the indexed window and backfills base positions', () => {
  const ledger = buildChain(tmpFile());
  const r = ledger.range(9, 15);
  // Sparse index checkpoints: seq 1, 8, 16. Nearest checkpoint <= 9 is 8.
  assert.equal(r.coveredFrom, 8);
  assert.equal(r.backfilled, 1);
  assert.equal(r.applied, 7);
  // Base positions come from the backfilled checkpoint block (seq 8).
  assert.equal(r.state.accounts.alice.position, 8);
  assert.equal(r.state.accounts.alice.frozen, 80);
  assert.equal(r.state.accounts.bob.position, 1000 - 8);
});

test('range from 1 matches a full replay', () => {
  const file = tmpFile();
  const ledger = buildChain(file);
  ledger.cancel('tx3');
  ledger.cancel('tx7');
  const r = ledger.range(1, ledger.store.blocks.length);
  const full = ledger.replay();
  assert.equal(r.backfilled, 0);
  assert.deepEqual(r.state, full.state);
});

test('range resolves dependencies on records before the window', () => {
  const file = tmpFile();
  const ledger = new Ledger(file, BASE);
  // Put fills inside the checkpoint region, cancel inside the window.
  for (let i = 1; i <= INDEX_SPAN; i++) {
    ledger.put({ txId: 'txA', buyer: 'alice', seller: 'bob', qty: 2, price: 5 });
  }
  ledger.cancel('txA'); // seq INDEX_SPAN + 1
  const r = ledger.range(INDEX_SPAN + 1, INDEX_SPAN + 1);
  assert.equal(r.coveredFrom, INDEX_SPAN);
  assert.equal(r.backfilled, 1);
  assert.equal(r.state.txs.txA.cancelled, true);
  // The cancel voids the fills visible in this window (the backfilled one).
  assert.equal(r.state.accounts.alice.frozen, 0);
  assert.equal(r.state.accounts.alice.position, 0);
  assert.equal(r.state.accounts.bob.position, 1000);
});

test('out-of-range reads are treated as corruption', () => {
  const ledger = buildChain(tmpFile(), 5);
  assert.throws(() => ledger.range(1, 99), (err) => err.code === 'CORRUPT');
  assert.throws(() => ledger.range(0, 2), (err) => err.code === 'USAGE');
  assert.throws(() => ledger.range(4, 2), (err) => err.code === 'USAGE');
});
