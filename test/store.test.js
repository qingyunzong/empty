import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initStore, appendOrders, createCheckpoint, rollback, verify, replay,
  loadManifest, serializeManifest, decode,
  DATA_FILE, MANIFEST_FILE, MANIFEST_TMP, HEADER_SIZE,
} from '../src/store.js';
import { crc32 } from '../src/crc32.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'planstore-'));
}

const A = [{ id: 'A1', quantity: 1, dueDate: '2026-10-01', capability: 2 }];
const B = [{ id: 'B1', quantity: 2, dueDate: '2026-10-02', capability: 3 }];
const C = [{ id: 'C1', quantity: 1, dueDate: '2026-10-03', capability: 1 }];

function chunkBytes(orders) {
  const payload = Buffer.from(JSON.stringify({ type: 'orders', orders }), 'utf8');
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt32LE(payload.length, 0);
  header.writeUInt32LE(crc32(payload), 4);
  return Buffer.concat([header, payload]);
}

test('rollback then replay yields a byte-identical manifest', () => {
  const dir = tmpdir();
  initStore(dir, 10);
  appendOrders(dir, A);
  createCheckpoint(dir, 'cp1');
  appendOrders(dir, B);
  appendOrders(dir, C);

  const r = rollback(dir, 'cp1');
  assert.equal(r.chunk, 1);
  assert.deepEqual(r.state.orders.map((o) => o.id), ['A1']);
  assert.equal(r.state.cumulativeLoad, 2);

  const before = fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8');
  const regenerated = replay(dir);
  const after = fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8');
  assert.equal(after, before);
  assert.equal(regenerated, before);
  assert.deepEqual(JSON.parse(after), JSON.parse(serializeManifest(loadManifest(dir))));

  // Rolled-back bytes are gone from the data file.
  const manifest = loadManifest(dir);
  const end = manifest.chunks.reduce((p, c) => p + c.length, 0);
  assert.equal(fs.statSync(path.join(dir, DATA_FILE)).size, end);
  assert.deepEqual(verify(dir), { chunks: 1, orders: 1, cumulativeLoad: 2, capacity: 10 });
});

test('rollback does not decode rolled-back chunks (corrupt tail ignored)', () => {
  const dir = tmpdir();
  initStore(dir, 10);
  appendOrders(dir, A);
  createCheckpoint(dir, 'cp1');
  appendOrders(dir, B);

  // Corrupt one payload byte inside chunk 1 (the chunk we will roll back).
  const manifest = loadManifest(dir);
  const fd = fs.openSync(path.join(dir, DATA_FILE), 'r+');
  const pos = manifest.chunks[1].offset + HEADER_SIZE;
  const orig = Buffer.alloc(1);
  fs.readSync(fd, orig, 0, 1, pos);
  fs.writeSync(fd, Buffer.from([orig[0] ^ 0xff]), 0, 1, pos);
  fs.closeSync(fd);

  // verify sees the corruption, but rollback to cp1 never decodes chunk 1.
  assert.throws(() => verify(dir), (err) => err.code === 'E_CRC' && err.chunk === 1);
  const r = rollback(dir, 'cp1');
  assert.deepEqual(r.state.orders.map((o) => o.id), ['A1']);
  assert.deepEqual(verify(dir), { chunks: 1, orders: 1, cumulativeLoad: 2, capacity: 10 });
});

test('corrupting one byte reports the chunk number; prefix decodes, tail does not pollute', () => {
  const dir = tmpdir();
  initStore(dir, 10);
  appendOrders(dir, A);
  appendOrders(dir, B);
  appendOrders(dir, C);

  const manifest = loadManifest(dir);
  const pos = manifest.chunks[1].offset + HEADER_SIZE + 2; // payload byte of chunk 1
  const fd = fs.openSync(path.join(dir, DATA_FILE), 'r+');
  const orig = Buffer.alloc(1);
  fs.readSync(fd, orig, 0, 1, pos);
  fs.writeSync(fd, Buffer.from([orig[0] ^ 0x01]), 0, 1, pos);
  fs.closeSync(fd);

  let caught;
  try {
    verify(dir);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'verify must throw');
  assert.equal(caught.code, 'E_CRC');
  assert.equal(caught.chunk, 1);
  assert.equal(caught.decodedChunks, 1);
  // Prefix state contains exactly chunk 0; chunks 1..2 never touched state.
  assert.deepEqual(caught.state.orders.map((o) => o.id), ['A1']);
  assert.equal(caught.state.cumulativeLoad, 2);
});

test('crash before manifest rename: tail invisible, append safe after restart', () => {
  const dir = tmpdir();
  initStore(dir, 10);
  appendOrders(dir, A);

  // Simulate a crashed append: chunk B bytes written + manifest.tmp prepared,
  // but the rename never happened.
  const manifest = loadManifest(dir);
  const endOfA = manifest.chunks.reduce((p, c) => p + c.length, 0);
  const crashed = JSON.parse(JSON.stringify(manifest));
  const chunkB = chunkBytes(B);
  crashed.chunks.push({ offset: endOfA, length: chunkB.length, crc32: crc32(chunkB.subarray(HEADER_SIZE)) });
  fs.appendFileSync(path.join(dir, DATA_FILE), chunkB);
  fs.writeFileSync(path.join(dir, MANIFEST_TMP), serializeManifest(crashed));
  // --- power loss here: no rename ---

  // Restart: only chunk 0 is visible.
  assert.deepEqual(verify(dir), { chunks: 1, orders: 1, cumulativeLoad: 2, capacity: 10 });

  // Appending is safe: stale tail is dropped, new chunk takes its place.
  const r = appendOrders(dir, C);
  assert.equal(r.chunk, 1);
  assert.deepEqual(verify(dir), { chunks: 2, orders: 2, cumulativeLoad: 3, capacity: 10 });
  const after = loadManifest(dir);
  assert.equal(after.chunks.reduce((p, c) => p + c.length, 0), fs.statSync(path.join(dir, DATA_FILE)).size);
  assert.deepEqual(verify(dir).orders, 2);
  const ids = decode(dir, after).state.orders.map((o) => o.id);
  assert.deepEqual(ids, ['A1', 'C1']);
});
