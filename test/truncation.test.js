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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txlog-trunc-'));
  return path.join(dir, 'log.bin');
}

function buildChain() {
  const file = tmpFile();
  const ledger = new Ledger(file, BASE);
  ledger.put({ txId: 'tx1', buyer: 'alice', seller: 'bob', qty: 2, price: 10 });
  ledger.put({ txId: 'tx2', buyer: 'alice', seller: 'bob', qty: 3, price: 10 });
  ledger.put({ txId: 'tx3', buyer: 'alice', seller: 'bob', qty: 4, price: 10 });
  ledger.cancel('tx1');
  return { ledger, file };
}

test('truncated last block: confirmed prefix recoverable after restart, truncated tx gone', () => {
  const { file } = buildChain();
  const size = fs.statSync(file).size;

  // Simulate a crash mid-write: cut the tail inside the last (cancel) block.
  const fd = fs.openSync(file, 'r+');
  fs.ftruncateSync(fd, size - 7);
  fs.closeSync(fd);

  // Reopening (restart) reports the incomplete block, pointing at its offset.
  let err;
  try {
    new Store(file);
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'expected an error');
  assert.equal(err.code, 'INCOMPLETE');
  assert.equal(typeof err.offset, 'number');

  // Recovery: discard the incomplete tail; the confirmed prefix loads cleanly.
  const confirmedSize = err.offset;
  const recovered = path.join(path.dirname(file), 'recovered.bin');
  const buf = Buffer.alloc(confirmedSize);
  const fd2 = fs.openSync(file, 'r');
  fs.readSync(fd2, buf, 0, confirmedSize, 0);
  fs.closeSync(fd2);
  fs.writeFileSync(recovered, buf);

  const ledger = new Ledger(recovered, BASE);
  const { blocks, state } = ledger.replay();
  assert.equal(blocks, 3);
  // The truncated cancel never happened: tx1 stays live with its freeze intact.
  assert.equal(state.txs.tx1.cancelled, false);
  assert.equal(state.accounts.alice.frozen, 2 * 10 + 3 * 10 + 4 * 10);
  assert.equal(state.accounts.alice.position, 9);
  assert.equal(state.accounts.bob.position, 500 - 9);
  // The chain still accepts new blocks after recovery.
  ledger.cancel('tx2');
  assert.equal(ledger.replay().state.txs.tx2.cancelled, true);
});

test('damaged length field within file bounds reports INCOMPLETE', () => {
  const { file } = buildChain();
  const store = new Store(file);
  const lastOffset = store.blocks[3].offset;

  const fd = fs.openSync(file, 'r+');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(3, 0); // absurdly small but stays inside the file
  fs.writeSync(fd, lenBuf, 0, 4, lastOffset + 6 + 8 + 32);
  fs.closeSync(fd);

  assert.throws(() => new Store(file), (err) => err.code === 'INCOMPLETE' && err.offset === lastOffset);
});

test('wild out-of-range length field is treated as corruption', () => {
  const { file } = buildChain();
  const store = new Store(file);
  const lastOffset = store.blocks[3].offset;

  const fd = fs.openSync(file, 'r+');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(0xffffffff, 0);
  fs.writeSync(fd, lenBuf, 0, 4, lastOffset + 6 + 8 + 32);
  fs.closeSync(fd);

  assert.throws(() => new Store(file), (err) => err.code === 'CORRUPT' && err.offset === lastOffset);
});

test('bit-flipped payload is detected via CRC32', () => {
  const { file } = buildChain();
  const store = new Store(file);
  const block2 = store.blocks[1];

  const fd = fs.openSync(file, 'r+');
  const one = Buffer.alloc(1);
  fs.readSync(fd, one, 0, 1, block2.offset + 60, null);
  one[0] ^= 0xff;
  fs.writeSync(fd, one, 0, 1, block2.offset + 60);
  fs.closeSync(fd);

  assert.throws(() => new Store(file), (err) => err.code === 'INCOMPLETE' && err.offset === block2.offset);
});

test('verify reports a healthy chain', () => {
  const { ledger } = buildChain();
  const v = ledger.verify();
  assert.equal(v.blocks, 4);
  assert.match(v.tip, /^[0-9a-f]{64}$/);
});
