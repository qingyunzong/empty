'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tmpdir, runCli, writeNdjson } = require('./helpers');
const { mergeTexts, SyncError } = require('../sync');

const post = { id: 'tx1', kind: 'post', causes: [], lamport: 1, node: 'A', amount: 10 };

function runMerge(dir, a, b) {
  writeNdjson(path.join(dir, 'a.ndjson'), a);
  writeNdjson(path.join(dir, 'b.ndjson'), b);
  return runCli(['merge', path.join(dir, 'a.ndjson'), path.join(dir, 'b.ndjson'), '--out', path.join(dir, 'out')]);
}

test('unknown cause exits with code 3', () => {
  const dir = tmpdir('err');
  const dangling = { id: 'tx2', kind: 'post', causes: ['ghost'], lamport: 1, node: 'B', amount: 5 };
  const r = runMerge(dir, [post], [dangling]);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /unknown cause/);
  assert.throws(
    () => mergeTexts(JSON.stringify(post) + '\n', JSON.stringify(dangling) + '\n'),
    (e) => e instanceof SyncError && e.code === 3
  );
});

test('cyclic causality exits with code 3', () => {
  const dir = tmpdir('err');
  const e1 = { id: 'tx1', kind: 'post', causes: ['tx2'], lamport: 1, node: 'A', amount: 10 };
  const e2 = { id: 'tx2', kind: 'post', causes: ['tx1'], lamport: 1, node: 'B', amount: 20 };
  const r = runMerge(dir, [e1], [e2]);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /cyclic/);
});

test('non-integer amount exits with code 3', () => {
  const dir = tmpdir('err');
  const bad = { id: 'tx9', kind: 'post', causes: [], lamport: 1, node: 'B', amount: 10.5 };
  const r = runMerge(dir, [post], [bad]);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /integer/);
});
