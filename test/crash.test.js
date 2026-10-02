'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Store } = require('../src/store');
const { tmpdir } = require('../testkit/helpers');

const DOCS = [
  { id: 'a', merchant: 'm1', amount: 10, tags: [], status: 'settled', text: 'red green blue' },
  { id: 'b', merchant: 'm2', amount: 20, tags: [], status: 'settled', text: 'green blue yellow' },
];

test('crash before commit marker: restart falls back to old index, no half segment', () => {
  const dir = tmpdir();
  let store = Store.open(dir);
  store.addRecords(DOCS);
  const v1 = store.indexVersion;

  // simulate an interrupted commit of v2: temp segment + temp marker, no rename
  fs.writeFileSync(path.join(dir, 'segment-2.tmp'), Buffer.from([1, 2, 3, 4]));
  fs.writeFileSync(path.join(dir, 'COMMIT.tmp'), '{"version":2');

  store = Store.open(dir);
  assert.equal(store.indexVersion, v1);
  assert.equal(store.query('green blue').hits.length, 2);
  // temp artifacts cleaned up
  assert.ok(!fs.existsSync(path.join(dir, 'segment-2.tmp')));
  assert.ok(!fs.existsSync(path.join(dir, 'COMMIT.tmp')));
});

test('orphan segment without commit marker is ignored and removed', () => {
  const dir = tmpdir();
  let store = Store.open(dir);
  store.addRecords(DOCS);
  const v1 = store.indexVersion;

  // a fully written segment that was never committed (marker rename never happened)
  const seg = fs.readFileSync(path.join(dir, 'segment-1.bin'));
  fs.writeFileSync(path.join(dir, 'segment-99.bin'), seg);

  store = Store.open(dir);
  assert.equal(store.indexVersion, v1);
  assert.ok(!fs.existsSync(path.join(dir, 'segment-99.bin')));
});

test('incremental deletes survive restart and stay consistent', () => {
  const dir = tmpdir();
  let store = Store.open(dir);
  store.addRecords(DOCS);
  store.delete('a');
  store.addRecords([{ id: 'c', merchant: 'm3', amount: 5, tags: [], status: 'settled', text: 'blue ocean' }]);
  store.delete('c');

  store = Store.open(dir);
  assert.equal(store.isLive('a'), false);
  assert.equal(store.isLive('b'), true);
  assert.equal(store.isLive('c'), false);
  assert.deepEqual(store.query('blue').hits.map((h) => h.id), ['b']);
});
