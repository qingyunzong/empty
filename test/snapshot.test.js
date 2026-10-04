// Acceptance 5: snapshot corruption detection and restore purity.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createStore,
  ingest,
  equiv,
  snapshot,
  writeSnapshot,
  restore,
  restoreFromString,
} from '../src/store.js';

function sampleStore() {
  const s = createStore();
  ingest(s, 'shift1', [
    { id: 'a', causes: [] },
    { id: 'b', causes: ['a'] },
  ]);
  ingest(s, 'shift2', [
    { id: 'b', causes: ['a'] },
    { id: 'a', causes: [] },
  ]);
  return s;
}

test('snapshot round-trips and preserves comparisons', () => {
  const s = sampleStore();
  const text = snapshot(s);
  const r = restoreFromString(text);
  assert.equal(r.status, 'OK');
  assert.equal(equiv(r.store, 'shift1', 'shift2').status, 'EQUAL');
});

test('truncated snapshot is RESTORE_CORRUPT and in-memory state is untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shiftlog-'));
  const file = join(dir, 'snap.json');
  const s = sampleStore();
  writeSnapshot(s, file);
  const original = readFileSync(file, 'utf8');

  for (const cut of [1, original.length >> 1, original.length - 2]) {
    const trunc = join(dir, `trunc-${cut}.json`);
    writeFileSync(trunc, original.slice(0, cut));
    const r = restore(trunc);
    assert.equal(r.status, 'RESTORE_CORRUPT', `cut=${cut}`);
    assert.equal(r.store, undefined);
  }
  // original in-memory store is unaffected and still fully usable
  assert.equal(equiv(s, 'shift1', 'shift2').status, 'EQUAL');
  // the snapshot file itself was not modified by failed restores
  assert.equal(readFileSync(file, 'utf8'), original);
});

test('tampered snapshot (bit flip) is detected via checksum', () => {
  const s = sampleStore();
  const text = snapshot(s);
  const i = text.indexOf('"shift1"');
  const flipped = text.slice(0, i + 2) + 'X' + text.slice(i + 3);
  const r = restoreFromString(flipped);
  assert.equal(r.status, 'RESTORE_CORRUPT');
  assert.match(r.reason, /checksum/);
});

test('structurally invalid snapshots are rejected', () => {
  assert.equal(restoreFromString('').status, 'RESTORE_CORRUPT');
  assert.equal(restoreFromString('null').status, 'RESTORE_CORRUPT');
  assert.equal(restoreFromString('[]').status, 'RESTORE_CORRUPT');
  assert.equal(restoreFromString('{"magic":"nope"}').status, 'RESTORE_CORRUPT');
  assert.equal(restoreFromString('{"magic":"shiftlog-snapshot","version":999}').status, 'RESTORE_CORRUPT');
  const s = sampleStore();
  const good = JSON.parse(snapshot(s));
  const badLogs = { ...good, logs: { x: [{ id: 'e', causes: 'bad' }] } };
  assert.equal(restoreFromString(JSON.stringify(badLogs)).status, 'RESTORE_CORRUPT');
});

test('restore of missing file is RESTORE_CORRUPT', () => {
  const r = restore('/tmp/definitely-not-here-shiftlog.json');
  assert.equal(r.status, 'RESTORE_CORRUPT');
});

test('restore returns an independent store (no shared mutation)', () => {
  const s = sampleStore();
  const text = snapshot(s);
  const r = restoreFromString(text);
  assert.equal(r.status, 'OK');
  ingest(r.store, 'shift3', [{ id: 'z', causes: [] }]);
  assert.equal(s.logs.has('shift3'), false);
});
