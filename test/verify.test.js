'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ledger = require('../src/ledger');
const { Store, buildChunk } = require('../src/store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'settle-verify-'));
}

function finalizeOne(dir) {
  ledger.propose(dir, {
    batchId: 'b1',
    transfers: [{ id: 't1', from: 'A', to: 'B', amount: 10 }],
    budgets: { A: 100 },
  });
  return ledger.finalize(dir, { batchId: 'b1' });
}

test('verify OK on a healthy store', () => {
  const dir = tmpDir();
  finalizeOne(dir);
  const r = ledger.verify(dir);
  assert.equal(r.code, 0);
  assert.deepEqual(r.lines, ['OK']);
});

test('verify reports CORRUPT for a tampered chunk (bad CRC)', () => {
  const dir = tmpDir();
  const chunk = finalizeOne(dir);
  const store = new Store(dir);
  const file = store.chunkPath(chunk.hash);
  const tampered = JSON.parse(fs.readFileSync(file, 'utf8'));
  tampered.deltas.A.net = 9999; // change payload without fixing crc32/hash
  fs.writeFileSync(file, JSON.stringify(tampered, null, 2));

  const r = ledger.verify(dir);
  assert.equal(r.code, 2);
  assert.ok(r.lines.some((l) => l.startsWith('CORRUPT')), r.lines.join('\n'));
});

test('verify reports MISSING for an unresolvable parent reference', () => {
  const dir = tmpDir();
  finalizeOne(dir);
  const store = new Store(dir);
  // Craft a self-consistent chunk whose parent does not exist.
  const orphan = buildChunk({
    batchId: 'bX',
    level: 7,
    parentHash: '0'.repeat(64),
    dependsOn: ['0'.repeat(64)],
    corrects: null,
    transfers: [],
    deltas: {},
    budgets: {},
    seq: 99,
    index: [],
  });
  store.writeChunk(orphan);

  const r = ledger.verify(dir);
  assert.equal(r.code, 2);
  assert.ok(r.lines.some((l) => l.startsWith('MISSING')), r.lines.join('\n'));
});

test('missing chunks are never treated as settleable/active', () => {
  const dir = tmpDir();
  finalizeOne(dir);
  const store = new Store(dir);
  const orphan = buildChunk({
    batchId: 'bX',
    level: 7,
    parentHash: 'f'.repeat(64),
    dependsOn: ['f'.repeat(64)],
    corrects: null,
    transfers: [],
    deltas: {},
    budgets: {},
    seq: 99,
    index: [],
  });
  store.writeChunk(orphan);

  const loaded = ledger.load(dir);
  assert.equal(loaded.statusOf(orphan.hash), 'missing');
  assert.equal(loaded.findByBatch('bX'), null);
  // Head is still the healthy b1 chunk, not the higher-level orphan.
  assert.equal(loaded.head().batchId, 'b1');
});
