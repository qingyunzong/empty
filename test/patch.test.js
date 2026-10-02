import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { buildSnapshot } from '../src/snapshot.js';
import { diffSnapshots } from '../src/diff.js';
import { patchRun, recover, applyChange } from '../src/patch.js';
import { makeRun, tmpdir } from '../testkit/helpers.js';

const CLI = fileURLToPath(new URL('../bin/rundiff.js', import.meta.url));
const schema = { tables: { t: { key: 'id', dependsOn: ['lr'] } } };
const csv = 'id,v\n1,0.5\n2,0.6\n';

function setup() {
  const dir = tmpdir();
  const runDir = makeRun(`${dir}/run`, {
    params: { lr: 0.001, epochs: 10 },
    schema,
    data: { t: csv },
  });
  const store = new Store(`${dir}/store`);
  store.saveSnapshot(buildSnapshot(runDir, 'run'));
  return { dir, runDir, store };
}

test('applyChange set/unset with dot paths', () => {
  const out = applyChange({ a: { b: 1 }, c: 2 }, { set: { 'a.b': 3, 'x.y': 4 }, unset: ['c'] });
  assert.deepEqual(out, { a: { b: 3 }, x: { y: 4 } });
});

test('patch updates params and snapshot incrementally (tables untouched)', () => {
  const { runDir, store } = setup();
  const before = store.loadSnapshot('run');
  patchRun(store, runDir, { set: { lr: 0.01 } });
  const after = store.loadSnapshot('run');
  assert.equal(after.params.lr, 0.01);
  assert.deepEqual(after.tables, before.tables);
  assert.notEqual(after.hash, before.hash);
  assert.equal(store.listJournals().length, 0);
});

test('undoing a parameter change restores an empty param diff', () => {
  const { runDir, store } = setup();
  const original = store.loadSnapshot('run');
  patchRun(store, runDir, { set: { lr: 0.01 } });
  patchRun(store, runDir, { set: { lr: 0.001 } });
  const restored = store.loadSnapshot('run');
  const d = diffSnapshots(original, restored);
  assert.deepEqual(d.params, []);
  assert.equal(original.hash, restored.hash);
});

test('crash after params write, before index update: recovery replays journal', () => {
  const { dir, runDir, store } = setup();
  const changeFile = `${dir}/change.json`;
  fs.writeFileSync(changeFile, JSON.stringify({ set: { lr: 0.05 } }));
  const env = {
    ...process.env,
    RUNDIFF_STORE: store.dir,
    RUNDIFF_CRASH_AFTER: 'params',
  };
  const crashed = spawnSync(process.execPath, [CLI, 'patch', runDir, changeFile], { env });
  assert.equal(crashed.status, 3);
  // params.json applied, snapshot index stale, journal present
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'params.json'), 'utf8')).lr, 0.05);
  assert.equal(store.loadSnapshot('run').params.lr, 0.001);
  assert.equal(store.listJournals().length, 1);
  // recovery via recheck (any command recovers first); the sandbox drops
  // grandchild stdio, so assert on exit code and filesystem state instead
  const q = { type: 'diff', a: 'run', b: 'run', options: null, resultHash: 'x' };
  store.saveQuery(q);
  const rec = spawnSync(process.execPath, [CLI, 'recheck'], { env: { ...process.env, RUNDIFF_STORE: store.dir } });
  assert.equal(rec.status, 4, 'recheck re-runs the query; params changed so MISMATCH=4');
  assert.equal(store.listJournals().length, 0);
  assert.equal(store.loadSnapshot('run').params.lr, 0.05);
  // replayable: a second recovery is a no-op
  assert.deepEqual(recover(store), []);
  assert.equal(store.loadSnapshot('run').params.lr, 0.05);
});

test('recover is idempotent when change already applied', () => {
  const { runDir, store } = setup();
  patchRun(store, runDir, { set: { lr: 0.02 } });
  // simulate a leftover journal from an interrupted run
  store.writeJournal({ id: 'left', runDir, change: { set: { lr: 0.02 }, unset: [] }, state: 'params-applied' });
  const recovered = recover(store);
  assert.deepEqual(recovered, ['left']);
  assert.equal(store.loadSnapshot('run').params.lr, 0.02);
  assert.deepEqual(recover(store), []);
});
