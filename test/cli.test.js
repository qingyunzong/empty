'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../cli');

const BASE_ARGS = ['--credit', 'alice:1000', '--position', 'bob:100'];

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txlog-cli-'));
  return path.join(dir, 'log.bin');
}

function okJson(r) {
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function errJson(r, status, code) {
  assert.equal(r.status, status, `expected exit ${status}, got ${r.status}: ${r.stdout}`);
  const parsed = JSON.parse(r.stderr);
  assert.equal(parsed.error.code, code);
  return parsed;
}

test('CLI happy path: put, partial fills, cancel, replay, verify, range', () => {
  const file = tmpFile();
  const put1 = okJson(run(['put', '--file', file, '--tx-id', 't1', '--buyer', 'alice', '--seller', 'bob', '--qty', '10', '--price', '5', ...BASE_ARGS]));
  assert.equal(put1.seq, 1);
  okJson(run(['put', '--file', file, '--tx-id', 't1', '--buyer', 'alice', '--seller', 'bob', '--qty', '4', '--price', '5', ...BASE_ARGS]));
  okJson(run(['put', '--file', file, '--tx-id', 't2', '--buyer', 'alice', '--seller', 'bob', '--qty', '6', '--price', '2', ...BASE_ARGS]));
  okJson(run(['cancel', '--file', file, '--tx-id', 't1', ...BASE_ARGS]));

  const replay = okJson(run(['replay', '--file', file, ...BASE_ARGS]));
  assert.equal(replay.blocks, 4);
  assert.equal(replay.state.txs.t1.cancelled, true);
  assert.equal(replay.state.accounts.alice.frozen, 12);
  assert.equal(replay.state.accounts.alice.position, 6);
  assert.equal(replay.state.accounts.bob.position, 94);

  const verify = okJson(run(['verify', '--file', file]));
  assert.equal(verify.ok, true);
  assert.equal(verify.blocks, 4);

  const range = okJson(run(['range', '--file', file, '--from', '2', '--to', '3', ...BASE_ARGS]));
  assert.equal(range.applied, 2);
  assert.equal(range.backfilled, 1);
  // backfill (seq 1: +10) + window (seq 2: +4, seq 3: +6)
  assert.equal(range.state.accounts.alice.position, 20);
});

test('CLI business conflicts exit 1', () => {
  const file = tmpFile();
  okJson(run(['put', '--file', file, '--tx-id', 't1', '--buyer', 'alice', '--seller', 'bob', '--qty', '10', '--price', '5', ...BASE_ARGS]));
  okJson(run(['cancel', '--file', file, '--tx-id', 't1', ...BASE_ARGS]));

  // Fill after full cancel is rejected.
  errJson(run(['put', '--file', file, '--tx-id', 't1', '--buyer', 'alice', '--seller', 'bob', '--qty', '1', '--price', '5', ...BASE_ARGS]), 1, 'CONFLICT');
  // Double cancel is rejected.
  errJson(run(['cancel', '--file', file, '--tx-id', 't1', ...BASE_ARGS]), 1, 'CONFLICT');
  // Insufficient credit.
  errJson(run(['put', '--file', file, '--tx-id', 't2', '--buyer', 'alice', '--seller', 'bob', '--qty', '999', '--price', '5', ...BASE_ARGS]), 1, 'CONFLICT');
  // Insufficient position.
  errJson(run(['put', '--file', file, '--tx-id', 't3', '--buyer', 'alice', '--seller', 'bob', '--qty', '500', '--price', '1', ...BASE_ARGS]), 1, 'CONFLICT');

  // Rejected operations left no trace.
  const verify = okJson(run(['verify', '--file', file]));
  assert.equal(verify.blocks, 2);
});

test('CLI truncated log exits 2 with INCOMPLETE and confirmed prefix is recoverable', () => {
  const file = tmpFile();
  okJson(run(['put', '--file', file, '--tx-id', 't1', '--buyer', 'alice', '--seller', 'bob', '--qty', '2', '--price', '5', ...BASE_ARGS]));
  okJson(run(['put', '--file', file, '--tx-id', 't2', '--buyer', 'alice', '--seller', 'bob', '--qty', '3', '--price', '5', ...BASE_ARGS]));

  // Simulate a crash mid-write of the third block.
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r+');
  fs.ftruncateSync(fd, size - 5);
  fs.closeSync(fd);

  errJson(run(['verify', '--file', file]), 2, 'INCOMPLETE');

  // Recover the confirmed prefix by discarding the incomplete tail.
  const { Store } = require('../lib/store');
  let offset;
  try {
    new Store(file);
  } catch (e) {
    offset = e.offset;
  }
  assert.equal(typeof offset, 'number');
  const fd2 = fs.openSync(file, 'r+');
  fs.ftruncateSync(fd2, offset);
  fs.closeSync(fd2);

  const replay = okJson(run(['replay', '--file', file, ...BASE_ARGS]));
  assert.equal(replay.blocks, 1);
  assert.equal(replay.state.txs.t2, undefined);
  assert.equal(replay.state.accounts.alice.position, 2);
});

test('CLI restart after truncation: confirmed prefix intact, truncated tx absent', () => {
  const file = tmpFile();
  okJson(run(['put', '--file', file, '--tx-id', 't1', '--buyer', 'alice', '--seller', 'bob', '--qty', '2', '--price', '5', ...BASE_ARGS]));
  okJson(run(['put', '--file', file, '--tx-id', 't2', '--buyer', 'alice', '--seller', 'bob', '--qty', '3', '--price', '5', ...BASE_ARGS]));
  okJson(run(['put', '--file', file, '--tx-id', 't3', '--buyer', 'alice', '--seller', 'bob', '--qty', '4', '--price', '5', ...BASE_ARGS]));

  // Find the start offset of the last block via the library, then truncate there.
  const { Store } = require('../lib/store');
  const store = new Store(file);
  const lastOffset = store.blocks[2].offset;
  const fd = fs.openSync(file, 'r+');
  fs.ftruncateSync(fd, lastOffset + 20); // cut inside block 3
  fs.closeSync(fd);

  errJson(run(['verify', '--file', file]), 2, 'INCOMPLETE');

  // Operator discards the incomplete tail and restarts.
  const fd2 = fs.openSync(file, 'r+');
  fs.ftruncateSync(fd2, lastOffset);
  fs.closeSync(fd2);

  const replay = okJson(run(['replay', '--file', file, ...BASE_ARGS]));
  assert.equal(replay.blocks, 2);
  assert.equal(replay.state.txs.t3, undefined);
  assert.equal(replay.state.accounts.alice.position, 5);

  // The log accepts new confirmed blocks after recovery.
  const put4 = okJson(run(['put', '--file', file, '--tx-id', 't4', '--buyer', 'alice', '--seller', 'bob', '--qty', '1', '--price', '5', ...BASE_ARGS]));
  assert.equal(put4.seq, 3);
});

test('CLI corrupt log exits 2', () => {
  const file = tmpFile();
  okJson(run(['put', '--file', file, '--tx-id', 't1', '--buyer', 'alice', '--seller', 'bob', '--qty', '2', '--price', '5', ...BASE_ARGS]));
  // Wild length field.
  const fd = fs.openSync(file, 'r+');
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(0xffffff00, 0);
  fs.writeSync(fd, buf, 0, 4, 6 + 8 + 32);
  fs.closeSync(fd);
  errJson(run(['verify', '--file', file]), 2, 'CORRUPT');
});

test('CLI usage errors exit 64', () => {
  const file = tmpFile();
  errJson(run(['bogus', '--file', file]), 64, 'USAGE');
  errJson(run(['put', '--file', file, '--tx-id', 't1']), 64, 'USAGE');
  errJson(run(['range', '--file', file, '--from', '3', '--to', '1']), 64, 'USAGE');
});
