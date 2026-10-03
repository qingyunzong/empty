import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store, buildIndex } from '../src/store.js';
import { tmpdir, mulberry32, Model, randomChange, stateToComparable } from '../testlib/helpers.js';

// Acceptance scenario 2: corrupt the index by hand; audit must report the
// divergence while WAL replay remains the correct source of truth.
test('corrupted index: audit reports divergence, replay stays correct', () => {
  const dir = tmpdir();
  const rand = mulberry32(99);
  const keys = Array.from({ length: 40 }, (_, i) => `m/${i}`);
  const devices = ['alpha', 'beta', 'gamma'];
  const model = new Model();
  const store = Store.open(dir);
  for (let i = 0; i < 200; i++) {
    const change = randomChange(rand, keys, devices);
    store.apply(change);
    model.apply(change);
  }

  const clean = store.audit();
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.divergences, []);

  // Sabotage: drop one device entirely, add a phantom key to another.
  const indexPath = path.join(dir, 'index.json');
  const broken = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const droppedDevice = Object.keys(broken)[0];
  const droppedKeys = broken[droppedDevice];
  delete broken[droppedDevice];
  const phantomDevice = Object.keys(broken)[0];
  broken[phantomDevice] = [...broken[phantomDevice], 'phantom/key'].sort();
  fs.writeFileSync(indexPath, JSON.stringify(broken));

  const report = store.audit();
  assert.equal(report.ok, false);
  for (const key of droppedKeys) {
    assert.ok(
      report.divergences.some((d) => d.deviceId === droppedDevice && d.key === key && d.kind === 'missing-in-index'),
      `expected missing-in-index for ${droppedDevice}/${key}`,
    );
  }
  assert.ok(
    report.divergences.some(
      (d) => d.deviceId === phantomDevice && d.key === 'phantom/key' && d.kind === 'stale-in-index',
    ),
  );

  // The index is only an accelerator: WAL replay is unaffected and correct.
  assert.deepEqual(stateToComparable(store.replay(200)), stateToComparable(model.at(200)));

  // Repair the index from the replayed truth; audit goes green again.
  fs.writeFileSync(indexPath, JSON.stringify(buildIndex(store.replay(200))));
  assert.equal(store.audit().ok, true);
  store.close();
});

test('audit on empty store is ok', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  const report = store.audit();
  assert.equal(report.ok, true);
  assert.equal(report.lastTxn, 0);
  store.close();
});
