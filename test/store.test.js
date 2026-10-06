import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'paycore-'));

function replayAll(records) {
  const e = new Engine();
  for (const r of records) e.apply(r);
  return e;
}

const OPS = [
  { op: 'init', limit: '20' },
  { op: 'freeze', tx: 'a', amt: '7/2' },
  { op: 'capture', tx: 'a', amt: '3/2' },
  { op: 'freeze', tx: 'b', amt: '4' },
  { op: 'void', tx: 'b' },
  { op: 'reverse', captureId: 'c0' },
];

function writeLog(file) {
  const { store } = Store.open(file);
  const engine = new Engine();
  for (const op of OPS) {
    const { record } = engine.apply(op);
    store.append(record);
  }
  return engine.snapshot();
}

test('acceptance 3: crash after record without checksum -> truncate + consistent replay', () => {
  const dir = tmp();
  const file = path.join(dir, 'log.txt');
  const before = writeLog(file);
  const sizeBefore = fs.statSync(file).size;

  // fault injection: record line written, checksum line never written
  fs.appendFileSync(file, JSON.stringify({ op: 'freeze', tx: 'ghost', amt: '1' }) + '\n');

  const { records, recovery } = Store.open(file);
  assert.equal(recovery.intactRecords, OPS.length);
  assert.equal(recovery.droppedRecords, 1);
  assert.ok(recovery.bytesRemoved > 0);
  assert.equal(fs.statSync(file).size, sizeBefore); // truncated back
  assert.deepEqual(replayAll(records).snapshot(), before); // replay consistent
});

test('crash with partial checksum line -> truncated at the record', () => {
  const dir = tmp();
  const file = path.join(dir, 'log.txt');
  const before = writeLog(file);
  const sizeBefore = fs.statSync(file).size;
  fs.appendFileSync(file, JSON.stringify({ op: 'void', tx: 'a' }) + '\n#deadbeef\n');
  const { records, recovery } = Store.open(file);
  assert.equal(recovery.droppedRecords, 1);
  assert.equal(fs.statSync(file).size, sizeBefore);
  assert.deepEqual(replayAll(records).snapshot(), before);
});

test('crash mid-record -> torn write dropped', () => {
  const dir = tmp();
  const file = path.join(dir, 'log.txt');
  const before = writeLog(file);
  fs.appendFileSync(file, '{"op":"freeze","tx":"tor');
  const { records, recovery } = Store.open(file);
  assert.equal(recovery.droppedRecords, 1);
  assert.ok(recovery.bytesRemoved > 0);
  assert.deepEqual(replayAll(records).snapshot(), before);
});

test('clean log recovers with zero drops', () => {
  const dir = tmp();
  const file = path.join(dir, 'log.txt');
  const before = writeLog(file);
  const { records, recovery } = Store.open(file);
  assert.deepEqual(recovery, { intactRecords: OPS.length, droppedRecords: 0, bytesRemoved: 0 });
  assert.deepEqual(replayAll(records).snapshot(), before);
});

test('E_IO on unopenable path', () => {
  assert.throws(() => Store.open('/nonexistent-dir-xyz/log.txt'), (e) => e.code === 'E_IO');
});
