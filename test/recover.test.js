'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Ledger, BizError, encodeBlock, decodeBlock } = require('../lib/ledger');
const { tmpLedgerDir } = require('./helpers');

function readFile(dir, name) {
  return fs.readFileSync(path.join(dir, name), 'utf8');
}

// Fault point from the spec: the batch body was written, the crash happened
// before the index (and state) update. Simulated by snapshotting state.json
// and index.json right before the settle and rolling them back afterwards,
// leaving the block body on disk.
function buildSingleOrphanCrash() {
  const dir = tmpLedgerDir();
  const ledger = new Ledger(dir);
  ledger.freeze('A', 1000);
  ledger.enqueue('p1', 'A', 100);
  ledger.settle(); // batch 1, fully confirmed

  ledger.enqueue('p2', 'A', 200);
  const stateSnapshot = readFile(dir, 'state.json');
  const indexSnapshot = readFile(dir, 'index.json');
  ledger.settle(); // batch 2 commits fully in the pre-crash timeline

  fs.writeFileSync(path.join(dir, 'state.json'), stateSnapshot);
  fs.writeFileSync(path.join(dir, 'index.json'), indexSnapshot);
  return { dir };
}

// Multi-orphan chain: batches 1..3 committed, then the index is truncated to
// the batch-1 entry (lost index updates). state.json keeps its contents; block
// bodies 2 and 3 are orphans chained on batch 1.
function buildMultiOrphanCrash() {
  const dir = tmpLedgerDir();
  const ledger = new Ledger(dir);
  ledger.freeze('A', 1000);
  ledger.enqueue('p1', 'A', 100);
  ledger.settle(); // batch 1
  ledger.enqueue('p2', 'A', 200);
  ledger.settle(); // batch 2
  ledger.enqueue('p3', 'A', 300);
  ledger.settle(); // batch 3

  const index = JSON.parse(readFile(dir, 'index.json'));
  index.batches = index.batches.slice(0, 1);
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index, null, 2));
  return { dir };
}

function corruptBlockBody(dir, batch, mutate) {
  const file = path.join(dir, 'blocks', String(batch).padStart(6, '0') + '.blk');
  const text = fs.readFileSync(file, 'utf8');
  const nl = text.indexOf('\n');
  const body = text.slice(nl + 1);
  fs.writeFileSync(file, text.slice(0, nl + 1) + mutate(body));
}

test('recover admits the orphaned body and patches the index (spec fault point)', () => {
  const { dir } = buildSingleOrphanCrash();
  const ledger = new Ledger(dir);
  // Before recover: only batch 1 confirmed; batch 2 body is an orphan.
  assert.equal(ledger.index.batches.length, 1);
  assert.deepEqual(ledger._orphans().map((o) => o.batch), [2]);
  assert.equal(ledger.verify().ok, false);
  assert.equal(ledger.snapshot().accounts.A.budget, 900); // post batch 1
  assert.equal(ledger.snapshot().accounts.A.frozen, 200); // p2 still queued
  assert.throws(() => ledger.settle(), /run recover first/);

  const r = ledger.recover();
  assert.equal(r.failed, null);
  assert.deepEqual(r.admitted.map((a) => a.batch), [2]);
  assert.equal(r.confirmed, 2);

  const recovered = new Ledger(dir);
  assert.equal(recovered.index.batches.length, 2);
  // Batch 2 effects applied exactly once: p2 settled, budget spent.
  assert.equal(recovered.snapshot().accounts.A.budget, 700);
  assert.equal(recovered.snapshot().accounts.A.frozen, 0);
  assert.equal(recovered.state.payments.p2.status, 'settled');
  assert.equal(recovered.verify().ok, true);
  // Operation resumes on the recovered chain.
  recovered.enqueue('p4', 'A', 50);
  assert.equal(recovered.settle().batch, 3);
  assert.equal(recovered.verify().ok, true);
});

test('recover re-admits a lost index suffix idempotently', () => {
  const { dir } = buildMultiOrphanCrash();
  const ledger = new Ledger(dir);
  const before = ledger.snapshot().accounts;
  assert.equal(ledger.index.batches.length, 1);
  assert.deepEqual(ledger._orphans().map((o) => o.batch), [2, 3]);

  const r = ledger.recover();
  assert.equal(r.failed, null);
  assert.deepEqual(r.admitted.map((a) => a.batch), [2, 3]);
  assert.equal(r.confirmed, 3);

  const recovered = new Ledger(dir);
  assert.equal(recovered.index.batches.length, 3);
  // Effects were already reflected in the state file; budgets must not move.
  assert.deepEqual(recovered.snapshot().accounts, before);
  assert.equal(recovered.snapshot().accounts.A.budget, 400); // 1000-100-200-300
  assert.equal(recovered.verify().ok, true);
});

test('CRC failure boundary: bad batch and its successors stay unavailable, confirmed prefix budgets unchanged', () => {
  const { dir } = buildMultiOrphanCrash();
  corruptBlockBody(dir, 2, (body) => body.replace('"amount":200', '"amount":201'));

  const ledger = new Ledger(dir);
  const prefixAccounts = ledger.snapshot().accounts;
  const r = ledger.recover();
  assert.deepEqual(r.admitted, []);
  assert.equal(r.failed.batch, 2);
  assert.match(r.failed.reason, /CRC32 mismatch/);
  assert.equal(r.confirmed, 1);

  const after = new Ledger(dir);
  // Confirmed prefix untouched: index still holds batch 1 only, budgets unchanged.
  assert.equal(after.index.batches.length, 1);
  assert.deepEqual(after.snapshot().accounts, prefixAccounts);
  // Batch 2 (corrupt) and batch 3 (valid but downstream) remain unavailable.
  assert.deepEqual(after._orphans().map((o) => o.batch), [2, 3]);
  assert.equal(after.verify().ok, false);
  // The confirmed prefix is still usable for new business.
  after.enqueue('p9', 'A', 10);
  assert.equal(after.snapshot().accounts.A.frozen, prefixAccounts.A.frozen + 10);
  assert.throws(() => after.settle(), /run recover first/);
});

test('recover admits valid orphans and stops at a later corrupt batch', () => {
  const { dir } = buildMultiOrphanCrash();
  corruptBlockBody(dir, 3, (body) => body.replace('"amount":300', '"amount":301'));

  const ledger = new Ledger(dir);
  const r = ledger.recover();
  assert.deepEqual(r.admitted.map((a) => a.batch), [2]);
  assert.equal(r.failed.batch, 3);
  assert.equal(r.confirmed, 2);

  const after = new Ledger(dir);
  assert.equal(after.index.batches.length, 2);
  assert.deepEqual(after._orphans().map((o) => o.batch), [3]);
  assert.equal(after.verify().ok, false);
});

test('recover with nothing to do is a no-op', () => {
  const dir = tmpLedgerDir();
  const ledger = new Ledger(dir);
  ledger.freeze('A', 100);
  ledger.enqueue('p1', 'A', 10);
  ledger.settle();
  const r = new Ledger(dir).recover();
  assert.deepEqual(r.admitted, []);
  assert.equal(r.failed, null);
  assert.equal(r.confirmed, 1);
});

test('recover rejects an orphan with broken chain linkage', () => {
  const { dir } = buildSingleOrphanCrash();
  // Rewrite batch 2 with a valid CRC32 but a wrong prevHash.
  const file = path.join(dir, 'blocks', '000002.blk');
  const body = decodeBlock(fs.readFileSync(file));
  body.prevHash = 'f'.repeat(64);
  fs.writeFileSync(file, encodeBlock(body));

  const ledger = new Ledger(dir);
  const r = ledger.recover();
  assert.deepEqual(r.admitted, []);
  assert.equal(r.failed.batch, 2);
  assert.match(r.failed.reason, /prevHash mismatch/);
  assert.equal(ledger.index.batches.length, 1);
});
