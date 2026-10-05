import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  VoucherStore, StoreError,
  INDEX_FILE, TMP_FILE, COMMIT_FILE, TOMBSTONE_FILE,
} from '../src/index.js';
import { decodePositions } from '../src/codec.js';

const DOCS = [
  { id: 'r1', merchant: 'Acme', amount: 11.5, tags: ['t'], text: 'red green blue red green', status: 'settled' },
  { id: 'r2', merchant: 'Beta', amount: 22, tags: [], text: 'green blue red', status: 'settled' },
  { id: 'r3', merchant: 'Acme', amount: 33, tags: ['t'], text: 'red blue green', status: 'pending' },
];

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readSegment(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, INDEX_FILE), 'utf8'));
}

test('revoke hides phrase, restore brings it back, tombstones survive restart', () => {
  const dir = tmpdir('voucher-life-');
  const store = VoucherStore.build(dir, DOCS);
  const before = store.phraseQuery('green blue', { slop: 0 });
  assert.deepEqual(before.matches.map((m) => m.id).sort(), ['r1', 'r2']);

  store.revoke('r1');
  assert.deepEqual(store.phraseQuery('green blue', { slop: 0 }).matches.map((m) => m.id), ['r2']);

  // restart: tombstones must still hide r1 (incremental delete persists)
  const reopened = VoucherStore.open(dir);
  assert.deepEqual(reopened.phraseQuery('green blue', { slop: 0 }).matches.map((m) => m.id), ['r2']);
  assert.equal(reopened.isLive('r1'), false);

  reopened.restore('r1');
  const restored = VoucherStore.open(dir);
  assert.deepEqual(restored.phraseQuery('green blue', { slop: 0 }).matches.map((m) => m.id).sort(), ['r1', 'r2']);
  assert.equal(restored.isLive('r1'), true);
});

test('compressed segment decodes to identical positions after revoke/restore', () => {
  const dir = tmpdir('voucher-seg-');
  const store = VoucherStore.build(dir, DOCS);
  const segmentBefore = readSegment(dir);
  // decode every compressed block and compare against fresh tokenization
  const tokensOf = (text) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const doc of DOCS) {
    const tokens = tokensOf(doc.text);
    const terms = [...new Set(tokens)];
    for (const term of terms) {
      const expected = tokens.flatMap((t, i) => (t === term ? [i] : []));
      const decoded = decodePositions(Buffer.from(segmentBefore.postings[term][doc.id], 'base64'));
      assert.deepEqual(decoded, expected, `${doc.id}:${term}`);
    }
  }
  // positions are compressed blocks, not JSON arrays
  assert.equal(typeof segmentBefore.postings.red.r1, 'string');
  store.revoke('r2');
  store.restore('r2');
  const segmentAfter = readSegment(dir);
  assert.deepEqual(segmentAfter.postings, segmentBefore.postings);
});

test('crash before commit: restart falls back to the old index, no half segment', () => {
  const dir = tmpdir('voucher-crash-');
  VoucherStore.build(dir, DOCS);
  const committed = fs.readFileSync(path.join(dir, INDEX_FILE), 'utf8');

  // simulate an interrupted update: partial temp segment, no commit marker
  fs.writeFileSync(path.join(dir, TMP_FILE), '{"version":2,"docs":{'); // truncated garbage
  const store = VoucherStore.open(dir);
  assert.equal(store.version, 1);
  assert.deepEqual(store.phraseQuery('green blue', { slop: 0 }).matches.map((m) => m.id).sort(), ['r1', 'r2']);
  assert.equal(fs.existsSync(path.join(dir, TMP_FILE)), false, 'stale temp segment cleaned up');
  assert.equal(fs.readFileSync(path.join(dir, INDEX_FILE), 'utf8'), committed);
});

test('crash after commit marker: restart completes the atomic replace', () => {
  const dir = tmpdir('voucher-commit-');
  const store = VoucherStore.build(dir, DOCS);
  const extra = { id: 'r4', merchant: 'Zeta', amount: 44, tags: [], text: 'red green gold', status: 'settled' };

  // simulate a crashed addRecords: temp segment + commit marker written, rename never happened
  const docs = Object.fromEntries([...store.docs.entries(), [extra.id, extra]].sort(([a], [b]) => (a < b ? -1 : 1)));
  const postings = JSON.parse(fs.readFileSync(path.join(dir, INDEX_FILE), 'utf8')).postings;
  postings.red.r4 = postings.red.r1; // reuse blocks only for shape; rebuild properly below
  const next = { version: 2, docs, postings };
  fs.writeFileSync(path.join(dir, TMP_FILE), JSON.stringify(next));
  fs.writeFileSync(path.join(dir, COMMIT_FILE), JSON.stringify({ tmp: TMP_FILE, target: INDEX_FILE, version: 2 }));

  const reopened = VoucherStore.open(dir);
  assert.equal(reopened.version, 2);
  assert.equal(fs.existsSync(path.join(dir, COMMIT_FILE)), false);
  assert.equal(fs.existsSync(path.join(dir, TMP_FILE)), false);
  assert.ok(reopened.docs.has('r4'));
});

test('incremental add bumps version and stays queryable after restart', () => {
  const dir = tmpdir('voucher-add-');
  const store = VoucherStore.build(dir, DOCS);
  store.addRecords([{ id: 'r9', merchant: 'New', amount: 99, tags: ['n'], text: 'green blue silver', status: 'settled' }]);
  assert.equal(store.version, 2);
  const reopened = VoucherStore.open(dir);
  const { matches, certificate } = reopened.phraseQuery('green blue', { slop: 0 });
  assert.deepEqual(matches.map((m) => m.id).sort(), ['r1', 'r2', 'r9']);
  assert.equal(certificate.indexVersion, 2);
});

test('library rejects unknown ids and illegal slop without touching state', () => {
  const dir = tmpdir('voucher-err-');
  const store = VoucherStore.build(dir, DOCS);
  const indexBefore = fs.readFileSync(path.join(dir, INDEX_FILE), 'utf8');
  const tombBefore = fs.readFileSync(path.join(dir, TOMBSTONE_FILE), 'utf8');

  assert.throws(() => store.revoke('nope'), (e) => e instanceof StoreError && e.code === 'UNKNOWN_ID');
  assert.throws(() => store.restore('nope'), (e) => e.code === 'UNKNOWN_ID');
  for (const slop of [-1, 1.5, NaN, Infinity, '1']) {
    assert.throws(() => store.phraseQuery('red green', { slop }), (e) => e.code === 'INVALID_SLOP');
  }
  assert.equal(fs.readFileSync(path.join(dir, INDEX_FILE), 'utf8'), indexBefore);
  assert.equal(fs.readFileSync(path.join(dir, TOMBSTONE_FILE), 'utf8'), tombBefore);
});
