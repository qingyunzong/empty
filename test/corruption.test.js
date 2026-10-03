import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.js';
import { E } from '../src/errors.js';
import { tmpRoot, at } from './helpers.js';

function setup() {
  const root = tmpRoot();
  const store = new Store(root);
  // 6 records with chunkSize 2 -> chunks 1..3, 2 records each
  store.initBatch({ batchId: 'A', baseline: 100, min: 95, max: 105, chunkSize: 2, at: at(0) });
  [101, 102, 103, 104, 105].forEach((v, i) =>
    store.appendMeasure('A', { value: v, at: at(i + 1) }));
  store.initBatch({ batchId: 'B', baseline: 50, min: 40, max: 60, chunkSize: 2, at: at(0) });
  store.appendMeasure('B', { value: 55, at: at(1) });
  return { root, store };
}

function chunkPath(root, batchId, n) {
  return path.join(root, batchId, 'chunks', `${String(n).padStart(6, '0')}.chk`);
}

function flipLastByte(file) {
  const buf = fs.readFileSync(file);
  buf[buf.length - 2] = buf[buf.length - 2] ^ 0xff;
  fs.writeFileSync(file, buf);
}

test('corrupt chunk payload returns E_CRC with boundary isolation', () => {
  const { root, store } = setup();
  flipLastByte(chunkPath(root, 'A', 2));

  let err;
  try {
    store.decode('A');
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'decode must throw');
  assert.equal(err.code, E.CRC);
  assert.match(err.details.chunk, /000002\.chk$/);
  // state before the damaged chunk stays recoverable; chunk 3 is not applied
  assert.equal(err.partial.history.length, 2);
  assert.deepEqual(err.partial.history.map((h) => h.value), [100, 101]);

  // restart: a fresh store over the same files reports identically
  const reopened = new Store(root);
  let err2;
  try {
    reopened.decode('A');
  } catch (e) {
    err2 = e;
  }
  assert.ok(err2);
  assert.equal(err2.code, E.CRC);
  assert.equal(err2.partial.history.length, 2);

  // the other batch is unaffected
  const viewB = reopened.decode('B');
  assert.equal(viewB.effective.value, 55);

  // scan isolates the corrupt batch and keeps going
  const report = reopened.scan();
  const a = report.find((r) => r.batchId === 'A');
  const b = report.find((r) => r.batchId === 'B');
  assert.equal(a.status, 'error');
  assert.equal(a.error, E.CRC);
  assert.equal(a.recovered, 2);
  assert.equal(b.status, 'ok');
});

test('corrupt last chunk: everything before the boundary survives', () => {
  const { root, store } = setup();
  flipLastByte(chunkPath(root, 'A', 3));
  let err;
  try {
    store.decode('A');
  } catch (e) {
    err = e;
  }
  assert.equal(err.code, E.CRC);
  assert.equal(err.partial.history.length, 4);
  assert.deepEqual(err.partial.history.map((h) => h.value), [100, 101, 102, 103]);
});

test('corrupt chunk header returns E_CRC', () => {
  const { root, store } = setup();
  const file = chunkPath(root, 'A', 1);
  const buf = fs.readFileSync(file);
  buf[2] = buf[2] ^ 0x01; // damage the magic
  fs.writeFileSync(file, buf);
  assert.throws(() => store.decode('A'), (err) => err.code === E.CRC);
});

test('truncated chunk returns E_CRC', () => {
  const { root, store } = setup();
  const file = chunkPath(root, 'A', 2);
  const buf = fs.readFileSync(file);
  fs.writeFileSync(file, buf.subarray(0, buf.length - 5));
  assert.throws(() => store.decode('A'), (err) => err.code === E.CRC);
});
