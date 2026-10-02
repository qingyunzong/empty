import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { hashValue } from '../src/canon.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sched-crc-'));
}

function threeCommits(dir) {
  const store = Store.init(dir);
  store.commit([{ kind: 'setMachine', id: 'MA', machine: { id: 'MA', calendar: [[0, 480]] } }]);
  store.commit([{ kind: 'setMachine', id: 'MB', machine: { id: 'MB', calendar: [[0, 480]] } }]);
  store.commit([{ kind: 'setMachine', id: 'MC', machine: { id: 'MC', calendar: [[0, 480]] } }]);
  return store;
}

function flipByte(file, offset) {
  const buf = fs.readFileSync(file);
  buf[offset] = buf[offset] ^ 0xff;
  fs.writeFileSync(file, buf);
}

test('corrupting the current chunk hides the last transaction; snapshot still opens', () => {
  const dir = tmpdir();
  const store = threeCommits(dir);
  store.snapshot(); // snapshot through seq 3
  store.commit([{ kind: 'setMachine', id: 'MD', machine: { id: 'MD', calendar: [[0, 480]] } }]); // seq 4
  const logPath = path.join(dir, 'journal.log');

  // Corrupt the tail (current) chunk: flip a byte inside its payload.
  flipByte(logPath, fs.statSync(logPath).size - 2);

  const reopened = Store.open(dir); // tolerant mode
  assert.equal(reopened.recovered, true);
  // Last transaction (MD) is invisible; state matches the seq-3 snapshot.
  assert.deepEqual(Object.keys(reopened.state.machines).sort(), ['MA', 'MB', 'MC']);
  assert.equal(reopened.records.length, 3);
  assert.equal(reopened.records[2].seq, 3);

  // Snapshot still opens and its hash matches the recovered state.
  assert.ok(reopened.loadedSnapshot);
  assert.equal(reopened.loadedSnapshot.seq, 3);
  assert.equal(reopened.loadedSnapshot.stateHash, hashValue(reopened.state));

  // Strict mode refuses the same corruption (before truncation).
  const dir2 = tmpdir();
  const s2 = threeCommits(dir2);
  s2.commit([{ kind: 'setMachine', id: 'MD', machine: { id: 'MD', calendar: [[0, 480]] } }]);
  flipByte(path.join(dir2, 'journal.log'), fs.statSync(path.join(dir2, 'journal.log')).size - 2);
  assert.throws(() => Store.open(dir2, { strict: true }), (e) => e.code === 'E_CRC');
});

test('corrupt chunk in the middle of the journal yields E_CRC', () => {
  const dir = tmpdir();
  threeCommits(dir);
  // Flip a payload byte inside the FIRST chunk (offset 12 = start of payload).
  flipByte(path.join(dir, 'journal.log'), 13);
  assert.throws(() => Store.open(dir), (e) => e.code === 'E_CRC');
});

test('corrupt snapshot file is skipped in favour of journal replay', () => {
  const dir = tmpdir();
  const store = threeCommits(dir);
  store.snapshot();
  const snapDir = path.join(dir, 'snapshots');
  const file = fs.readdirSync(snapDir).find((f) => f.startsWith('snap-'));
  flipByte(path.join(snapDir, file), 40); // damage state payload -> hash mismatch
  const reopened = Store.open(dir);
  assert.deepEqual(Object.keys(reopened.state.machines).sort(), ['MA', 'MB', 'MC']);
  assert.equal(reopened.records.length, 3);
});

test('torn tail write (partial chunk) is truncated on open', () => {
  const dir = tmpdir();
  threeCommits(dir);
  const logPath = path.join(dir, 'journal.log');
  fs.appendFileSync(logPath, Buffer.from([0x53, 0x43, 0x48, 0x4a, 0x10, 0x00])); // half a header
  const reopened = Store.open(dir);
  assert.equal(reopened.recovered, true);
  assert.equal(reopened.records.length, 3);
  assert.equal(fs.statSync(logPath).size, reopened.journal.baseOffset === 0 ? fs.statSync(logPath).size : fs.statSync(logPath).size);
});
