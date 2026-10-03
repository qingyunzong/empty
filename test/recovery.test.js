import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventStore } from '../src/store.js';

class SimulatedCrash extends Error {}

function tmpWal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-rec-'));
  return path.join(dir, 'events.wal');
}

function crashNow() {
  throw new SimulatedCrash();
}

// Simulates process death at a fault point: the append is interrupted, the
// store object is abandoned (only the fd is closed, no further writes), and a
// fresh store recovers from the on-disk bytes.
function crashAppend(wal, events, crashAt) {
  const store = EventStore.open(wal);
  try {
    for (let i = 0; i < events.length; i += 1) {
      const opts = i === events.length - 1 ? { crashAt, onCrash: crashNow } : {};
      store.append(events[i], opts);
    }
  } catch (err) {
    if (!(err instanceof SimulatedCrash)) throw err;
  } finally {
    store.close();
  }
}

const e1 = { eventId: 'e1', deviceId: 'dev-A', seq: 1, type: 'start' };
const e2 = { eventId: 'e2', deviceId: 'dev-A', seq: 2, type: 'alarm' };

test('fault point after_data: crashed event is not visible after recovery', () => {
  const wal = tmpWal();
  crashAppend(wal, [e1, e2], 'after_data');
  const store = EventStore.open(wal);
  assert.deepEqual(store.all(), [e1]);
  assert.equal(store.get('e2'), null);
  assert.deepEqual(store.query('dev-A', 2), []);
  store.close();
});

test('fault point after_sync: crashed event is not visible after recovery', () => {
  const wal = tmpWal();
  crashAppend(wal, [e1, e2], 'after_sync');
  const store = EventStore.open(wal);
  assert.deepEqual(store.all(), [e1]);
  assert.equal(store.get('e2'), null);
  store.close();
});

test('fault point after_commit: crashed event IS visible after recovery', () => {
  const wal = tmpWal();
  crashAppend(wal, [e1, e2], 'after_commit');
  const store = EventStore.open(wal);
  assert.deepEqual(store.all(), [e1, e2]);
  assert.deepEqual(store.get('e2'), e2);
  assert.deepEqual(store.query('dev-A', 2), [e2]);
  store.close();
});

test('event lost in a crash can be re-appended (no phantom E_DUP)', () => {
  const wal = tmpWal();
  crashAppend(wal, [e1, e2], 'after_sync');
  const store = EventStore.open(wal);
  store.append(e2); // must not raise E_DUP
  assert.deepEqual(store.all(), [e1, e2]);
  store.close();
});

test('garbage tail bytes are truncated as incomplete', () => {
  const wal = tmpWal();
  let store = EventStore.open(wal);
  store.append(e1);
  store.append(e2);
  store.close();

  fs.appendFileSync(wal, Buffer.from([0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x01]));
  store = EventStore.open(wal);
  assert.deepEqual(store.all(), [e1, e2]);
  assert.equal(store.truncatedBytes, 6);
  assert.equal(fs.statSync(wal).size, store.size);
  store.close();
});

test('tail CRC error is truncated; earlier committed prefix survives', () => {
  const wal = tmpWal();
  let store = EventStore.open(wal);
  store.append(e1);
  store.append(e2);
  store.close();

  // Corrupt one byte inside the second data frame payload.
  const size = fs.statSync(wal).size;
  const fd = fs.openSync(wal, 'r+');
  const buf = Buffer.alloc(size);
  fs.readSync(fd, buf, 0, size, 0);
  buf[size - 20] ^= 0xFF; // inside e2's frame (data payload or commit area)
  fs.writeSync(fd, buf, 0, size, 0);
  fs.closeSync(fd);

  store = EventStore.open(wal);
  assert.deepEqual(store.all(), [e1]);
  assert.ok(store.truncatedBytes > 0);
  store.close();
});

test('corrupted commit frame makes its data frame invisible', () => {
  const wal = tmpWal();
  let store = EventStore.open(wal);
  store.append(e1);
  store.close();

  // Flip the last byte of the file: the commit frame CRC.
  const size = fs.statSync(wal).size;
  const fd = fs.openSync(wal, 'r+');
  const one = Buffer.alloc(1);
  fs.readSync(fd, one, 0, 1, size - 1);
  one[0] ^= 0xFF;
  fs.writeSync(fd, one, 0, 1, size - 1);
  fs.closeSync(fd);

  store = EventStore.open(wal);
  assert.deepEqual(store.all(), []);
  assert.equal(store.truncatedBytes, 13); // exactly the commit frame
  store.close();
});
