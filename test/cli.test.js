'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../cli');

// The sandbox forbids spawning child processes, so the CLI is exercised through
// its exported run(argv) entry point — the same code path the shell wrapper uses.

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wovcs-'));
  return path.join(dir, 'store.json');
}

function runOk(args) {
  const r = run(args);
  assert.equal(r.status, 0, `expected success, got ${r.status}: ${r.stderr}`);
  assert.equal(r.stderr, '');
  return JSON.parse(r.stdout);
}

test('CLI: commit/branch/merge/undo/query end to end', () => {
  const store = makeStore();

  const v1 = runOk(['commit', '--store', store, '--branch', 'main', '--doc', 'WO-1',
    '--set', 'title=泵P-1检修', '--set', 'notes=轴承过热需更换']);
  assert.equal(v1.id, 'v1');
  assert.equal(v1.clock, 1);

  runOk(['branch', '--store', store, '--name', 'dev', '--from', 'main']);
  runOk(['commit', '--store', store, '--branch', 'dev', '--doc', 'WO-1',
    '--set', 'notes=轴承磨损，继续观察']);
  runOk(['commit', '--store', store, '--branch', 'main', '--doc', 'WO-1',
    '--set', 'notes=轴承过热，已复测']);

  // Unresolved merge conflict: status 1 with E_CONFLICT and conflict fields.
  const conflict = run(['merge', '--store', store, '--into', 'main', '--from', 'dev']);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /E_CONFLICT/);
  assert.match(conflict.stderr, /WO-1 notes/);
  assert.match(conflict.stderr, /轴承磨损，继续观察/);

  const merged = runOk(['merge', '--store', store, '--into', 'main', '--from', 'dev',
    '--resolve', 'WO-1.notes=轴承过热，安排更换']);
  assert.equal(merged.merged, true);

  const q1 = runOk(['query', '--store', store, '--phrase', '安排更换', '--branch', 'main']);
  assert.deepEqual(q1.docs, ['WO-1']);

  // Undo the merge commit; history stays, old versions still queryable.
  const undoV = runOk(['undo', '--store', store, '--branch', 'main', '--version', merged.version.id]);
  assert.match(undoV.message, /undo/);
  const qOld = runOk(['query', '--store', store, '--phrase', '过热需更换', '--as-of', 'v1']);
  assert.deepEqual(qOld.docs, ['WO-1']);
  const qMerged = runOk(['query', '--store', store, '--phrase', '安排更换', '--as-of', merged.version.id]);
  assert.deepEqual(qMerged.docs, ['WO-1']);
  const qTip = runOk(['query', '--store', store, '--phrase', '安排更换', '--branch', 'main']);
  assert.deepEqual(qTip.docs, []);
});

test('CLI: E_CLOCK and E_VERSION surface as error codes', () => {
  const store = makeStore();
  runOk(['commit', '--store', store, '--branch', 'main', '--doc', 'WO-1',
    '--set', 'notes=x', '--clock', '5']);

  const badClock = run(['commit', '--store', store, '--branch', 'main', '--doc', 'WO-1',
    '--set', 'notes=y', '--clock', '5']);
  assert.equal(badClock.status, 1);
  assert.match(badClock.stderr, /E_CLOCK/);

  const badVersion = run(['query', '--store', store, '--phrase', 'x', '--as-of', 'v42']);
  assert.equal(badVersion.status, 1);
  assert.match(badVersion.stderr, /E_VERSION/);

  const badUndo = run(['undo', '--store', store, '--branch', 'main', '--version', 'v42']);
  assert.equal(badUndo.status, 1);
  assert.match(badUndo.stderr, /E_VERSION/);
});
