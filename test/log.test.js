import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendRecord, injectTornRecord, replay, hashGraph, encodeRecord, CRASH_POINTS, PersistError } from '../src/log.js';
import { Graph } from '../src/graph.js';

function tmpLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glog-'));
  return path.join(dir, 'graph.log');
}

function buildCommittedLog(logPath) {
  appendRecord(logPath, { seq: 1, op: 'add_edge', u: 0, v: 1 });
  appendRecord(logPath, { seq: 2, op: 'add_edge', u: 1, v: 2 });
  appendRecord(logPath, { seq: 3, op: 'add_edge', u: 2, v: 0 });
  appendRecord(logPath, { seq: 4, op: 'commit' });
  const g = new Graph();
  g.addEdge(0, 1); g.addEdge(1, 2); g.addEdge(2, 0);
  return hashGraph(g);
}

test('recover on missing or empty file: applied=0 discarded=0', () => {
  const p = tmpLog();
  let st = replay(p);
  assert.equal(st.applied, 0);
  assert.equal(st.discarded, 0);
  assert.equal(st.graph.edgeCount, 0);
  fs.writeFileSync(p, '');
  st = replay(p);
  assert.equal(st.applied, 0);
  assert.equal(st.discarded, 0);
  assert.equal(st.stateHash, hashGraph(new Graph()));
});

for (const point of CRASH_POINTS) {
  test(`crash at ${point}: torn record discarded, confirmed ops replayed, deterministic`, () => {
    const p = tmpLog();
    const expectedHash = buildCommittedLog(p);
    injectTornRecord(p, 5, 0, 1); // torn del_edge of an existing edge
    const st = replay(p);
    assert.equal(st.applied, 3);
    assert.equal(st.discarded, 1);
    assert.equal(st.stateHash, expectedHash);
    // torn del_edge must NOT be treated as a deletion
    assert.deepEqual(st.graph.edges(), [[0, 1], [1, 2], [0, 2]].sort((a, b) => a[0] - b[0] || a[1] - b[1]));
    assert.ok(st.graph.hasEdge(0, 1));
    // recovery is idempotent / deterministic
    const again = replay(p);
    assert.equal(again.applied, 3);
    assert.equal(again.discarded, 0);
    assert.equal(again.stateHash, expectedHash);
    // log continues to be appendable after recovery
    appendRecord(p, { seq: 5, op: 'del_edge', u: 0, v: 1 });
    const after = replay(p);
    assert.equal(after.applied, 4);
    assert.ok(!after.graph.hasEdge(0, 1));
  });
}

test('torn record on empty log is discarded, not applied', () => {
  const p = tmpLog();
  injectTornRecord(p, 1, 0, 1);
  const st = replay(p);
  assert.equal(st.applied, 0);
  assert.equal(st.discarded, 1);
  assert.equal(st.graph.edgeCount, 0);
  assert.equal(fs.readFileSync(p).length, 0);
});

test('complete record with bad checksum -> PERSIST_CORRUPT', () => {
  const p = tmpLog();
  appendRecord(p, { seq: 1, op: 'add_edge', u: 0, v: 1 });
  const bad = JSON.parse(encodeRecord({ seq: 2, op: 'add_edge', u: 1, v: 2 }));
  bad.sum = 'deadbeefdeadbeef';
  fs.appendFileSync(p, JSON.stringify(bad) + '\n');
  assert.throws(() => replay(p), (e) => e instanceof PersistError && e.code === 'PERSIST_CORRUPT');
});

test('sequence gap -> PERSIST_CORRUPT', () => {
  const p = tmpLog();
  appendRecord(p, { seq: 1, op: 'add_edge', u: 0, v: 1 });
  appendRecord(p, { seq: 3, op: 'add_edge', u: 1, v: 2 });
  assert.throws(() => replay(p), (e) => e.code === 'PERSIST_CORRUPT');
});

test('log inconsistent with itself (del of missing edge) -> PERSIST_CORRUPT', () => {
  const p = tmpLog();
  appendRecord(p, { seq: 1, op: 'del_edge', u: 0, v: 1 });
  assert.throws(() => replay(p), (e) => e.code === 'PERSIST_CORRUPT');
});

test('garbage bytes as a complete line -> PERSIST_CORRUPT', () => {
  const p = tmpLog();
  appendRecord(p, { seq: 1, op: 'add_edge', u: 0, v: 1 });
  fs.appendFileSync(p, 'not json at all\n');
  assert.throws(() => replay(p), (e) => e.code === 'PERSIST_CORRUPT');
});

test('commit records are durable no-ops; state hash only reflects edges', () => {
  const p = tmpLog();
  appendRecord(p, { seq: 1, op: 'add_edge', u: 3, v: 4 });
  appendRecord(p, { seq: 2, op: 'commit' });
  appendRecord(p, { seq: 3, op: 'commit' });
  const st = replay(p);
  assert.equal(st.applied, 1);
  assert.equal(st.recordCount, 3);
  const g = new Graph();
  g.addEdge(3, 4);
  assert.equal(st.stateHash, hashGraph(g));
});
