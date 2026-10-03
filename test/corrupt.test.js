// ERR_CORRUPT identifies the damaged segment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommandLog, ERR_CORRUPT } from '../src/log.js';
import { truncateAt } from '../src/fault.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoclave-log-'));
}

test('truncating a manifested segment mid-data -> ERR_CORRUPT names the segment', () => {
  const dir = tmpdir();
  const log = CommandLog.open(dir);
  log.append('close_door');
  log.append('lock_door');
  log.commit(); // segment 0, manifested
  log.append('heat_on');
  log.commit(); // segment 1, manifested

  // truncate segment 0 in the middle of its first record line
  truncateAt(path.join(dir, 'seg-0.log'), 12);

  const r = CommandLog.recover(dir);
  assert.equal(r.corrupt.length, 1);
  assert.equal(r.corrupt[0].error, ERR_CORRUPT);
  assert.equal(r.corrupt[0].segment, 0);
  assert.match(r.corrupt[0].reason, /@COMMIT|record|crc/);
  // nothing visible, and the scan stops at the bad segment
  assert.deepEqual(r.events, []);
  assert.deepEqual(r.discarded, []);
});

test('crc mismatch in a manifested segment -> ERR_CORRUPT', () => {
  const dir = tmpdir();
  const log = CommandLog.open(dir);
  log.append('close_door');
  log.commit();

  // flip one byte inside the record without touching @COMMIT
  const seg0 = path.join(dir, 'seg-0.log');
  const text = fs.readFileSync(seg0, 'utf8');
  const at = text.indexOf('close_door');
  const mutated = `${text.slice(0, at)}X${text.slice(at + 1)}`;
  fs.writeFileSync(seg0, mutated);

  const r = CommandLog.recover(dir);
  assert.equal(r.corrupt.length, 1);
  assert.deepEqual(r.corrupt[0].segment, 0);
  assert.equal(r.corrupt[0].error, ERR_CORRUPT);
  assert.equal(r.corrupt[0].reason, 'crc mismatch');
});

test('corrupt later segment keeps earlier committed batches visible', () => {
  const dir = tmpdir();
  const log = CommandLog.open(dir);
  log.append('close_door');
  log.commit(); // segment 0
  log.append('lock_door');
  log.commit(); // segment 1 -> will be corrupted

  truncateAt(path.join(dir, 'seg-1.log'), 8);

  const r = CommandLog.recover(dir);
  assert.deepEqual(r.events, [{ type: 'cmd', name: 'close_door' }]);
  assert.deepEqual(r.corrupt.map((c) => c.segment), [1]);
  assert.equal(r.corrupt[0].error, ERR_CORRUPT);
});
