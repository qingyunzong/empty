import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Graph } from '../src/graph.js';
import { encodeGraph } from '../src/format.js';
import { Store, ConflictError } from '../src/store.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'route-store-'));
}

function graphBuffer(nodeIds) {
  const g = Graph.fromJSON({
    devices: [{ id: 'm', capacity: 10 }],
    nodes: nodeIds.map((id, i) => ({ id, device: 'm', time: i + 1, load: 1 })),
    edges: nodeIds.slice(1).map((id, i) => ({ from: nodeIds[i], to: id })),
  });
  return encodeGraph(g, { chunkSize: 2 });
}

function runConflictScenario() {
  const dir = tmpdir();
  const store = Store.init(dir);
  const v0 = store.commit({ base: null, readSet: [], writeSet: [], buffer: graphBuffer(['A', 'B', 'C']) });
  const v1 = store.commit({ base: v0.hash, readSet: ['B'], writeSet: ['B'], buffer: graphBuffer(['A', 'B', 'C', 'D']) });
  let certificate = null;
  try {
    store.commit({ base: v0.hash, readSet: ['C', 'B'], writeSet: ['C'], buffer: graphBuffer(['A', 'B', 'C', 'E']) });
  } catch (err) {
    assert.ok(err instanceof ConflictError);
    certificate = err.certificate;
  }
  return { certificate, v0, v1 };
}

test('concurrent edits to the same read-set node yield a stable conflict certificate', () => {
  const first = runConflictScenario();
  const second = runConflictScenario();
  assert.ok(first.certificate, 'expected a conflict certificate');
  assert.equal(first.certificate.error, 'E_CONFLICT');
  assert.equal(first.certificate.baseHash, first.v0.hash);
  assert.equal(first.certificate.theirHash, first.v1.hash);
  assert.deepEqual(first.certificate.readSet, ['B', 'C']);
  assert.deepEqual(first.certificate.conflictingNodes, ['B']);
  assert.equal(first.certificate.commonAncestor, first.v0.hash);
  assert.deepEqual(first.certificate, second.certificate);
  assert.equal(JSON.stringify(first.certificate), JSON.stringify(second.certificate));
});

test('commits touching unrelated nodes succeed sequentially', () => {
  const dir = tmpdir();
  const store = Store.init(dir);
  const v0 = store.commit({ base: null, readSet: [], writeSet: [], buffer: graphBuffer(['A', 'B', 'C']) });
  const v1 = store.commit({ base: v0.hash, readSet: ['A'], writeSet: ['A'], buffer: graphBuffer(['A', 'B', 'C', 'D']) });
  const v2 = store.commit({ base: v1.hash, readSet: ['C'], writeSet: ['C'], buffer: graphBuffer(['A', 'B', 'C', 'E']) });
  assert.equal(v1.parent, v0.hash);
  assert.equal(v2.parent, v1.hash);
  assert.equal(store.versions.size, 3);
});

test('unrelated writes on divergent branches do not conflict', () => {
  const dir = tmpdir();
  const store = Store.init(dir);
  const v0 = store.commit({ base: null, readSet: [], writeSet: [], buffer: graphBuffer(['A', 'B']) });
  store.commit({ base: v0.hash, readSet: ['A'], writeSet: ['A'], buffer: graphBuffer(['A', 'B', 'C']) });
  const v2 = store.commit({ base: v0.hash, readSet: ['B'], writeSet: ['B'], buffer: graphBuffer(['A', 'B', 'D']) });
  assert.equal(v2.parent, v0.hash);
});

test('read-set overlap with a later ancestor commit conflicts with correct ancestor', () => {
  const dir = tmpdir();
  const store = Store.init(dir);
  const v0 = store.commit({ base: null, readSet: [], writeSet: [], buffer: graphBuffer(['A']) });
  const v1 = store.commit({ base: v0.hash, readSet: ['A'], writeSet: ['A'], buffer: graphBuffer(['A', 'B']) });
  const v2 = store.commit({ base: v1.hash, readSet: ['B'], writeSet: ['B'], buffer: graphBuffer(['A', 'B', 'C']) });
  try {
    store.commit({ base: v0.hash, readSet: ['B'], writeSet: ['A'], buffer: graphBuffer(['A', 'Z']) });
    assert.fail('expected conflict');
  } catch (err) {
    assert.equal(err.code, 'E_CONFLICT');
    assert.equal(err.certificate.theirHash, v2.hash);
    assert.equal(err.certificate.commonAncestor, v0.hash);
  }
});

test('unknown base version is rejected', () => {
  const store = Store.init(tmpdir());
  assert.throws(
    () => store.commit({ base: 'deadbeef', readSet: [], writeSet: [], buffer: graphBuffer(['A']) }),
    (err) => err.code === 'E_UNKNOWN_BASE',
  );
});

test('store persists versions across reloads', () => {
  const dir = tmpdir();
  const store = Store.init(dir);
  const v0 = store.commit({ base: null, readSet: [], writeSet: [], buffer: graphBuffer(['A', 'B']) });
  const reloaded = Store.init(dir);
  assert.ok(reloaded.versions.has(v0.hash));
  assert.deepEqual(reloaded.getBuffer(v0.hash), store.getBuffer(v0.hash));
});
