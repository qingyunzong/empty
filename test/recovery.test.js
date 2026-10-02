'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const engine = require('../src/engine');
const chain = require('../src/chain');
const store = require('../src/store');
const { tmpdir } = require('../testlib/helpers');

function setupThreeBatches(dir) {
  engine.createAccount(dir, 'A', 1000);
  engine.enqueue(dir, 'A', 'p1', 100);
  engine.settle(dir);
  engine.enqueue(dir, 'A', 'p2', 200);
  engine.settle(dir);
  engine.enqueue(dir, 'A', 'p3', 300);
  engine.settle(dir);
}

function truncateIndex(dir, keep) {
  const entries = chain.readIndex(dir);
  fs.writeFileSync(
    chain.indexPath(dir),
    entries.slice(0, keep).map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
  return entries;
}

test('recover admits a fully written batch whose index entry was lost', () => {
  const dir = tmpdir();
  setupThreeBatches(dir);
  truncateIndex(dir, 2); // crash after batch body 3 was written, before index update

  const stateBefore = store.loadState(dir);
  assert.equal(chain.verifyChain(dir).ok, false, 'verify flags the missing index entry');

  const result = chain.recoverChain(dir);
  assert.equal(result.corrupt, false);
  assert.deepEqual(result.admitted, [3]);
  assert.equal(chain.readIndex(dir).length, 3);
  assert.equal(chain.verifyChain(dir).ok, true);
  assert.equal(chain.readBatch(dir, 3).body.seq, 3);
  assert.deepEqual(store.loadState(dir), stateBefore, 'recover never touches budgets');
});

test('recover keeps a crc-corrupt batch and its successors unavailable; prefix budgets unchanged', () => {
  const dir = tmpdir();
  setupThreeBatches(dir);
  const entries = truncateIndex(dir, 1); // only batch 1 confirmed in the index

  // Corrupt one body byte of batch 2 (past the 4-byte length header).
  const fd = fs.openSync(chain.logPath(dir), 'r+');
  const byte = Buffer.alloc(1);
  fs.readSync(fd, byte, 0, 1, entries[1].offset + 4);
  byte[0] ^= 0xff;
  fs.writeSync(fd, byte, 0, 1, entries[1].offset + 4);
  fs.closeSync(fd);

  const stateBefore = store.loadState(dir);
  const result = chain.recoverChain(dir);
  assert.equal(result.corrupt, true);
  assert.deepEqual(result.admitted, []);
  assert.equal(result.validBatches, 1);
  assert.equal(chain.readIndex(dir).length, 1, 'batches 2 and 3 stay unavailable');

  // Confirmed prefix budgets are untouched by recovery.
  assert.deepEqual(store.loadState(dir), stateBefore);
  assert.equal(store.loadState(dir).accounts.A.used, 600, 'state was applied when batches were written');

  // Batch 1 still decodes; batch 2 is not reachable through the index, and
  // incremental decoding stops at the corrupt block.
  assert.equal(chain.readBatch(dir, 1).body.seq, 1);
  assert.throws(() => chain.readBatch(dir, 2), /not indexed/);
  const next = chain.decodeNext(dir, 1);
  assert.equal(next.batch, null);
  assert.match(next.error, /crc32 mismatch/);
  assert.equal(chain.verifyChain(dir).ok, false);
});

test('recover admits the valid prefix before a corrupt tail', () => {
  const dir = tmpdir();
  setupThreeBatches(dir);
  const entries = truncateIndex(dir, 1);

  // Corrupt batch 3, leaving batch 2 valid but unindexed.
  const fd = fs.openSync(chain.logPath(dir), 'r+');
  const byte = Buffer.alloc(1);
  fs.readSync(fd, byte, 0, 1, entries[2].offset + 4);
  byte[0] ^= 0xff;
  fs.writeSync(fd, byte, 0, 1, entries[2].offset + 4);
  fs.closeSync(fd);

  const result = chain.recoverChain(dir);
  assert.equal(result.corrupt, true);
  assert.deepEqual(result.admitted, [2], 'valid prefix batch is admitted');
  assert.equal(chain.readIndex(dir).length, 2);
  assert.throws(() => chain.readBatch(dir, 3), /not indexed/);
});

test('recover on a healthy chain is a no-op', () => {
  const dir = tmpdir();
  setupThreeBatches(dir);
  const result = chain.recoverChain(dir);
  assert.equal(result.corrupt, false);
  assert.deepEqual(result.admitted, []);
  assert.equal(chain.verifyChain(dir).ok, true);
});
