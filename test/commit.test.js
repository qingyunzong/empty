'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Platform } = require('../src/platform');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-'));
}

test('commit produces generation roots and undo rolls back by generation', () => {
  const dir = tmpDir();
  const p = new Platform({ cpu: 4, mem: 4, stateDir: dir });
  p.submit({ id: 'a', bytes: 2 });
  const g1 = p.commit();
  assert.equal(g1.generation, 1);
  p.submit({ id: 'b', deps: ['a'], bytes: 3 });
  p.schedule();
  const g2 = p.commit();
  assert.equal(g2.generation, 2);
  assert.notEqual(g1.root, g2.root);

  const undone = p.undo();
  assert.equal(undone.generation, 1);
  assert.equal(undone.root, g1.root, 'lineage hash matches generation 1 after rollback');
  assert.equal(p.nodes.has('b'), false);
  assert.equal(p.stateRoot(), g1.root);

  const undone0 = p.undo();
  assert.equal(undone0.generation, 0);
  assert.equal(p.nodes.size, 0);
  assert.throws(() => p.undo(), /no committed generation/);
});

test('state root is stable across serialize/deserialize (lineage hash consistent)', () => {
  const dir = tmpDir();
  const p = new Platform({ cpu: 4, mem: 4, quotas: { alice: 50 }, stateDir: dir });
  p.submit({ id: 'x', owner: 'alice', bytes: 5 });
  p.submit({ id: 'y', owner: 'alice', deps: ['x'], bytes: 5 });
  p.schedule();
  const committed = p.commit();
  const loaded = Platform.load(dir);
  assert.equal(loaded.stateRoot(), committed.root);
  assert.equal(loaded.stateRoot(), p.stateRoot());
});

test('acceptance: crash mid-commit recovers all-or-nothing', () => {
  // Case 1: crash after journal write, before atomic rename -> old generation intact.
  const dir1 = tmpDir();
  const p1 = new Platform({ cpu: 4, mem: 4, stateDir: dir1 });
  p1.submit({ id: 'a', bytes: 2 });
  const g1 = p1.commit();
  p1.submit({ id: 'b', bytes: 3 });
  assert.throws(() => p1.commit({ crashAfter: 'journal' }), /simulated crash/);
  const recovered1 = Platform.load(dir1);
  assert.equal(recovered1.generation, 1);
  assert.equal(recovered1.stateRoot(), g1.root, 'partial commit is invisible after recovery');
  assert.equal(recovered1.nodes.has('b'), false);
  assert.equal(fs.existsSync(path.join(dir1, 'journal.json')), false, 'journal cleaned up');

  // Case 2: clean commit -> new generation fully visible.
  const dir2 = tmpDir();
  const p2 = new Platform({ cpu: 4, mem: 4, stateDir: dir2 });
  p2.submit({ id: 'a', bytes: 2 });
  p2.commit();
  p2.submit({ id: 'b', bytes: 3 });
  const g2 = p2.commit();
  const recovered2 = Platform.load(dir2);
  assert.equal(recovered2.generation, 2);
  assert.equal(recovered2.stateRoot(), g2.root, 'completed commit fully visible');
  assert.equal(recovered2.nodes.has('b'), true);
});

test('undo persists and recovery after undo sees the rolled-back generation', () => {
  const dir = tmpDir();
  const p = new Platform({ cpu: 4, mem: 4, stateDir: dir });
  p.submit({ id: 'a', bytes: 2 });
  const g1 = p.commit();
  p.submit({ id: 'b', bytes: 1 });
  p.commit();
  p.undo();
  const recovered = Platform.load(dir);
  assert.equal(recovered.generation, 1);
  assert.equal(recovered.stateRoot(), g1.root);
});
