import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendRecords, recoverRecords } from '../src/wal.js';
import { replay } from '../src/engine.js';

const EVENTS = [
  { seq: 1, requestId: 'open', type: 'open_account', account: 'a1', limit: 500 },
  { seq: 2, requestId: 'auth1', type: 'authorize', authId: 'au1', account: 'a1', amount: 200 },
  { seq: 3, requestId: 'cap1', type: 'capture', authId: 'au1', amount: 80, merchant: 'm1' },
];

test('crash before fsync: torn tail is truncated and replay matches last durable state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-'));
  const log = path.join(dir, 'events.log');

  appendRecords(log, EVENTS.slice(0, 2));
  const durableSize = fs.statSync(log).size;

  const fd = fs.openSync(log, 'a');
  const tornLine = `${JSON.stringify(EVENTS[2]).slice(0, 20)}`; // partial JSON, no newline, never fsynced
  fs.writeSync(fd, tornLine);
  fs.closeSync(fd); // simulate crash: no fsync, garbage may persist
  assert.ok(fs.statSync(log).size > durableSize);

  const { records, truncated, truncatedBytes } = recoverRecords(log);
  assert.equal(truncated, true);
  assert.ok(truncatedBytes > 0);
  assert.deepEqual(records, EVENTS.slice(0, 2));
  assert.equal(fs.statSync(log).size, durableSize);

  const snap = replay(records).snapshot();
  assert.equal(snap.accounts.a1.held, 200);
  assert.equal(snap.accounts.a1.captured, 0);
  assert.equal(snap.accounts.a1.available, 300);
  assert.deepEqual(snap.merchants, {});

  const second = recoverRecords(log);
  assert.equal(second.truncated, false);
  assert.equal(second.records.length, 2);
});

test('corrupt line in the middle stops recovery at that point', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-'));
  const log = path.join(dir, 'events.log');
  appendRecords(log, EVENTS.slice(0, 1));
  fs.appendFileSync(log, 'not-json-at-all\n');
  const { records, truncated } = recoverRecords(log);
  assert.equal(truncated, true);
  assert.deepEqual(records, EVENTS.slice(0, 1));
});

test('clean log recovers everything without truncation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-'));
  const log = path.join(dir, 'events.log');
  appendRecords(log, EVENTS);
  const { records, truncated } = recoverRecords(log);
  assert.equal(truncated, false);
  assert.deepEqual(records, EVENTS);
  const snap = replay(records).snapshot();
  assert.equal(snap.accounts.a1.captured, 80);
  assert.equal(snap.merchants.m1.settled, 80);
});
