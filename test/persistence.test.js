import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initStore, listCommittedBatches, loadStore, undo } from '../src/store.js';
import { makeTempDir } from '../support/helpers.js';

const nodes = () => [
  { id: 'a', parentId: null, amount: 10, reason: 'pay refund now', state: 'active' },
  { id: 'b', parentId: 'a', amount: 20, reason: 'pay refund later', state: 'active' },
];

function setup() {
  const dir = makeTempDir();
  initStore(dir, nodes());
  return dir;
}

test('missing commit marker means not undone after restart', () => {
  const dir = setup();
  const res = undo(dir, { rootId: 'a', phrase: ['pay', 'refund'], slop: 0, budget: 100 });
  assert.equal(res.ok, true);
  assert.deepEqual(loadStore(dir).nodes.map((n) => n.state), ['undone', 'undone']);

  // Simulate a crash: batch file exists but its commit marker is gone.
  fs.unlinkSync(path.join(dir, 'batches', '000001.commit'));
  const reloaded = loadStore(dir);
  assert.deepEqual(reloaded.nodes.map((n) => n.state), ['active', 'active']);
  assert.deepEqual(reloaded.batches, []);
  assert.deepEqual(listCommittedBatches(dir), []);

  // A later undo reuses the freed sequence number and overwrites the stale file.
  const again = undo(dir, { rootId: 'a', phrase: ['pay', 'refund'], slop: 0, budget: 100 });
  assert.equal(again.ok, true);
  assert.equal(again.batchId, 'BATCH-000001');
  assert.deepEqual(loadStore(dir).nodes.map((n) => n.state), ['undone', 'undone']);
});

test('stray tmp files and uncommitted batch files are ignored', () => {
  const dir = setup();
  fs.writeFileSync(path.join(dir, 'nodes.json.tmp-999'), 'garbage');
  fs.writeFileSync(path.join(dir, 'batches', '000003.json'), '{"batchId":"BATCH-000003"}');
  const { nodes: loaded, batches } = loadStore(dir);
  assert.deepEqual(loaded.map((n) => n.state), ['active', 'active']);
  assert.deepEqual(batches, []);
  assert.deepEqual(listCommittedBatches(dir), []);
});

test('undo is atomic: no tmp files remain and state is fully applied', () => {
  const dir = setup();
  const res = undo(dir, { rootId: 'a', phrase: ['pay', 'refund'], slop: 0, budget: 100 });
  assert.equal(res.ok, true);
  const leftovers = [];
  for (const file of fs.readdirSync(dir)) if (file.includes('.tmp-')) leftovers.push(file);
  for (const file of fs.readdirSync(path.join(dir, 'batches'))) {
    if (file.includes('.tmp-')) leftovers.push(`batches/${file}`);
  }
  assert.deepEqual(leftovers, []);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'batches')).sort(), [
    '000001.commit',
    '000001.json',
  ]);
});

test('multiple committed batches apply in order with increasing batch ids', () => {
  const dir = makeTempDir();
  initStore(dir, [
    { id: 'a', parentId: null, amount: 10, reason: 'pay refund', state: 'active' },
    { id: 'b', parentId: null, amount: 20, reason: 'cancel order', state: 'active' },
  ]);
  const r1 = undo(dir, { rootId: 'a', phrase: ['pay', 'refund'], slop: 0, budget: 100 });
  const r2 = undo(dir, { rootId: 'b', phrase: ['cancel', 'order'], slop: 0, budget: 100 });
  assert.deepEqual([r1.batchId, r2.batchId], ['BATCH-000001', 'BATCH-000002']);
  assert.deepEqual(listCommittedBatches(dir), [1, 2]);
  assert.deepEqual(loadStore(dir).nodes.map((n) => n.state), ['undone', 'undone']);
});
