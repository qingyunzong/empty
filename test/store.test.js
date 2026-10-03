import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from '../src/crc32.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';

function freshStore(opts) {
  const dir = mkdtempSync(join(tmpdir(), 'txstore-'));
  return { dir, store: new Store(dir, opts) };
}

function seedThree(store) {
  const e = new Engine(store);
  const p = e.put({ txId: 'T1', price: 100, qty: 5, author: 'a' });
  const r = e.replace({ txId: 'T1', price: 101, author: 'b' });
  const r2 = e.replace({ txId: 'T1', qty: 7, author: 'c' });
  return [p.head, r.head, r2.head];
}

test('crc32 matches known check vector', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('records carry parent hash, author seq, crc and offset index entries', () => {
  const { store } = freshStore();
  const heads = seedThree(store);
  const idx = store.readIndex();
  assert.equal(idx.ok, true);
  assert.equal(idx.entries.length, 3);
  const { records } = store.scan();
  assert.deepEqual(records[1].parents, [heads[0]]);
  assert.deepEqual(records[2].parents, [heads[1]]);
  for (const e of idx.entries) {
    const rec = records.find((r) => r.hash === e.hash);
    assert.deepEqual(rec._loc, { chunk: e.chunk, offset: e.offset, length: e.length });
  }
});

test('chunk rollover produces multiple chunk files', () => {
  const { dir, store } = freshStore({ maxChunkSize: 200 });
  seedThree(store);
  const chunks = readdirSync(join(dir, 'chunks')).sort();
  assert.ok(chunks.length >= 2, `expected >=2 chunks, got ${chunks}`);
  assert.equal(store.verify().ok, true);
  assert.equal(store.verify().chunks, chunks.length);
});

test('acceptance 3: deleted index is detected and rebuilt from the reverse chain', () => {
  const { dir, store } = freshStore();
  seedThree(store);
  rmSync(join(dir, 'index.idx'));
  const v1 = store.verify();
  assert.equal(v1.ok, false);
  assert.equal(v1.error, 'INDEX_MISSING');
  const v2 = store.verify({ rebuild: true });
  assert.equal(v2.ok, true);
  assert.equal(v2.rebuilt, true);
  assert.equal(v2.indexEntries, 3);
  assert.equal(store.verify().ok, true);
  // materialize still works off the rebuilt store
  const m = new Engine(store).materialize({ txId: 'T1' });
  assert.equal(m.price, 101);
  assert.equal(m.qty, 7);
});

test('acceptance 3: corrupted index page is detected and rebuilt', () => {
  const { dir, store } = freshStore();
  seedThree(store);
  const p = join(dir, 'index.idx');
  const buf = readFileSync(p);
  buf[10] ^= 0xff; // flip payload bits inside the index page
  writeFileSync(p, buf);
  const v1 = store.verify();
  assert.equal(v1.ok, false);
  assert.equal(v1.error, 'INDEX_CORRUPT');
  const v2 = store.verify({ rebuild: true });
  assert.equal(v2.ok, true);
  assert.equal(v2.rebuilt, true);
  assert.equal(store.verify().ok, true);
});

test('acceptance 3: broken reverse chain reports the first missing version', () => {
  // One record per chunk so corrupting the middle record leaves the
  // surrounding blocks intact and breaks the parent chain.
  const { dir, store } = freshStore({ maxChunkSize: 1 });
  const heads = seedThree(store);
  const chunk2 = join(dir, 'chunks', 'chunk-000002.bin');
  const buf = readFileSync(chunk2);
  buf[buf.length - 1] ^= 0xff; // corrupt payload tail -> CRC mismatch
  writeFileSync(chunk2, buf);
  const v = store.verify({ rebuild: true });
  assert.equal(v.ok, false);
  assert.equal(v.error, 'CHAIN_BROKEN');
  assert.equal(v.chain, 'BROKEN');
  assert.equal(v.firstMissing.hash, heads[1]); // the corrupted middle revision
  assert.equal(v.firstMissing.referencedBy, heads[2]);
});

test('corrupt block without rebuild reports BLOCK_CORRUPT', () => {
  const { dir, store } = freshStore();
  seedThree(store);
  const chunk1 = join(dir, 'chunks', 'chunk-000001.bin');
  const buf = readFileSync(chunk1);
  buf[15] ^= 0xff;
  writeFileSync(chunk1, buf);
  const v = store.verify();
  assert.equal(v.ok, false);
  assert.equal(v.error, 'BLOCK_CORRUPT');
  assert.equal(v.corruptBlocks[0].reason, 'CRC_MISMATCH');
});
