import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.js';
import { tmpRoot, at } from './helpers.js';

test('compensation lost in a crash before manifest rename stays invisible', () => {
  const root = tmpRoot();
  const store = new Store(root);
  store.initBatch({ batchId: 'B-200', baseline: 100, min: 95, max: 105, chunkSize: 2, at: at(0) });
  store.appendMeasure('B-200', { value: 106, at: at(1) }); // seq 1
  store.appendMeasure('B-200', { value: 105, at: at(2) }); // seq 2

  // Simulate crash: chunk data (incl. the compensation) is written and
  // renamed into place, but the process dies before the manifest rename.
  const manifest = store._loadManifest('B-200');
  store._appendRecords(manifest, [
    { type: 'compensate', refs: 1, value: 104, reason: 'lost in crash', at: at(3) },
  ], { commit: false });

  // Same-process readers only see committed state.
  let view = store.decode('B-200');
  assert.equal(view.history.length, 3);
  assert.equal(view.effective.value, 105);
  assert.equal(view.correctionReason, null);
  assert.ok(!view.history.some((h) => h.type === 'compensate'));

  // After a restart the uncommitted compensation is still invisible.
  const reopened = new Store(root);
  view = reopened.decode('B-200');
  assert.equal(view.history.length, 3);
  assert.equal(view.effective.value, 105);
  assert.ok(!view.history.some((h) => h.type === 'compensate'));

  // The next committed write reuses the seq and cleanly replaces the orphan
  // chunk tail; the crashed compensation never leaks into the log.
  reopened.appendMeasure('B-200', { value: 103, at: at(4) });
  view = reopened.decode('B-200');
  assert.equal(view.history.length, 4);
  assert.equal(view.effective.seq, 3);
  assert.equal(view.effective.value, 103);
  assert.ok(!view.history.some((h) => h.type === 'compensate'));
});

test('stale tmp files from crashed writes are ignored', () => {
  const root = tmpRoot();
  const store = new Store(root);
  store.initBatch({ batchId: 'B-201', baseline: 10, min: 0, max: 20, chunkSize: 1, at: at(0) });
  store.appendMeasure('B-201', { value: 12, at: at(1) });

  // leftovers from crashed write attempts
  fs.writeFileSync(path.join(root, 'B-201', 'manifest.json.tmp'), '{"garbage"');
  fs.writeFileSync(path.join(root, 'B-201', 'chunks', '000003.chk.tmp'), 'junk');

  const reopened = new Store(root);
  const view = reopened.decode('B-201');
  assert.equal(view.history.length, 2);
  assert.equal(view.effective.value, 12);
  assert.equal(reopened.listBatches().length, 1);
  assert.equal(reopened.scan()[0].status, 'ok');

  // committed appends still work afterwards
  reopened.appendMeasure('B-201', { value: 11, at: at(2) });
  assert.equal(reopened.decode('B-201').effective.value, 11);
});

test('manifest rename is atomic: readers never see a partial manifest', () => {
  const root = tmpRoot();
  const store = new Store(root);
  store.initBatch({ batchId: 'B-202', baseline: 1, min: 0, max: 2, chunkSize: 1, at: at(0) });
  for (let i = 0; i < 20; i += 1) {
    store.appendMeasure('B-202', { value: 1, at: at(i + 1) });
    const view = new Store(root).decode('B-202');
    assert.equal(view.history.length, i + 2);
  }
});
