'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { Store } = require('../src/store');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'crash_child.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-wal-'));
}

test('acceptance 4: kill -9 after segment write / before index write recovers deterministically', () => {
  for (let run = 0; run < 3; run += 1) {
    const dir = tmpDir();
    const child = spawnSync(process.execPath, [FIXTURE, dir], { encoding: 'utf8' });
    assert.equal(child.signal, 'SIGKILL', `run ${run}: child must die by SIGKILL`);
    assert.equal(child.stdout.includes('UNREACHABLE'), false);

    const store = Store.open(dir);
    // committed batch fully visible
    assert.equal(store.graph.hasLot('A'), true);
    assert.equal(store.graph.hasLot('B'), true);
    assert.equal(store.graph.edges.has('e1'), true);
    // uncommitted batch fully invisible (no partial state)
    assert.equal(store.graph.hasLot('C'), false);
    assert.equal(store.ops.length, 3);
    assert.equal(store.applied, 3);

    // deterministic across reopen: same answer every time
    const again = Store.open(dir);
    assert.equal(again.graph.hasLot('C'), false);
    assert.equal(again.applied, 3);

    // undo/redo still work after recovery
    assert.equal(store.undo(), true);
    assert.equal(store.graph.edges.has('e1'), false);
    assert.equal(store.redo(), true);
    assert.equal(store.graph.edges.has('e1'), true);

    // and the log keeps accepting commits at the right lsn after recovery
    store.addLot({ id: 'D', kind: 'wip', qty: 5, status: 'in_stock' });
    const reopened = Store.open(dir);
    assert.equal(reopened.graph.hasLot('D'), true);
    assert.equal(reopened.graph.hasLot('C'), false);
  }
});

test('undo/redo pointer survives process restart via WAL', () => {
  const dir = tmpDir();
  let store = Store.open(dir);
  store.addLot({ id: 'A', kind: 'raw', qty: 100, status: 'quarantine' });
  store.addLot({ id: 'B', kind: 'finished', qty: 50, status: 'in_stock' });
  store.addEdge({ id: 'e1', from: 'A', to: 'B', kind: 'split', qty: 50, ratio: 0.5, time: 1 });
  store.undo(); // e1 unapplied, but still in the log for redo
  store = Store.open(dir);
  assert.equal(store.applied, 2);
  assert.equal(store.graph.edges.has('e1'), false);
  assert.equal(store.redo(), true);
  assert.equal(store.graph.edges.has('e1'), true);
  store = Store.open(dir);
  assert.equal(store.graph.edges.has('e1'), true);
  assert.equal(store.applied, 3);
});

test('snapshot truncates WAL and recovery replays from snapshot base', () => {
  const dir = tmpDir();
  let store = Store.open(dir);
  store.addLot({ id: 'A', kind: 'raw', qty: 100, status: 'quarantine' });
  store.addLot({ id: 'B', kind: 'finished', qty: 50, status: 'in_stock' });
  store.addEdge({ id: 'e1', from: 'A', to: 'B', kind: 'split', qty: 50, ratio: 0.5, time: 1 });
  store.snapshot();
  store.correctEdge('e1', { ratio: 0.8, qty: 80 });
  store.undo();
  store = Store.open(dir);
  assert.equal(store.graph.edges.get('e1').ratio, 0.5);
  assert.equal(store.redo(), true);
  assert.equal(store.graph.edges.get('e1').ratio, 0.8);
  // impact survives the snapshot round-trip
  const impact = store.impact('A', 0.5);
  assert.deepEqual(impact.affected.map((a) => a.lot), ['B']);
  assert.equal(impact.certificate.minimal, true);
});
