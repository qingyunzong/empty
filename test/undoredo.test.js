'use strict';

// Acceptance 3: after interleaved add/del/undo/redo, the library state
// equals replaying the effective (non-undone) log from scratch.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RuleLibrary } = require('../src/rulelib');
const { runRulesLog } = require('../src/engine');

const LOG = [
  { op: 'add', id: 'a', kind: 'red', pattern: 'AB' },
  { op: 'add', id: 'b', kind: 'yellow', pattern: 'S+' },
  { op: 'add', id: 'c', kind: 'red', pattern: 'BA' },
  { op: 'del', id: 'a' },
  { op: 'undo' }, // restores a
  { op: 'undo' }, // removes c
  { op: 'redo' }, // re-adds c
  { op: 'add', id: 'd', kind: 'yellow', pattern: 'A' }, // clears redo stack
  { op: 'undo', k: 2 }, // removes d, restores a again
  { op: 'redo' }, // re-deletes a
];

// Simulates the log on the operation list itself to compute the effective
// layer sequence (undo/redo semantics applied to the log, not the library).
function effectiveLayers(log) {
  const layers = [];
  const redoStack = [];
  for (const entry of log) {
    if (entry.op === 'add' || entry.op === 'del') {
      layers.push([entry]);
      redoStack.length = 0;
    } else if (entry.op === 'undo') {
      const k = entry.k === undefined ? 1 : entry.k;
      for (let j = 0; j < k; j++) redoStack.push(layers.pop());
    } else if (entry.op === 'redo') {
      const k = entry.k === undefined ? 1 : entry.k;
      for (let j = 0; j < k; j++) layers.push(redoStack.pop());
    }
  }
  return layers.flat();
}

function applyEntries(entries) {
  const lib = new RuleLibrary();
  for (const e of entries) {
    if (e.op === 'add') {
      lib.applyLayer([{ type: 'add', id: e.id, kind: e.kind, pattern: e.pattern }]);
    } else if (e.op === 'del') {
      lib.applyLayer([{ type: 'del', id: e.id }]);
    } else if (e.op === 'undo') {
      lib.undo(e.k);
    } else if (e.op === 'redo') {
      lib.redo(e.k);
    }
  }
  return lib;
}

test('interleaved undo/redo matches replaying the effective log', () => {
  const live = applyEntries(LOG);
  const replayed = applyEntries(effectiveLayers(LOG));
  assert.equal(live.snapshotHash(), replayed.snapshotHash());
  assert.deepEqual(
    [...live.rules.keys()].sort(),
    [...replayed.rules.keys()].sort()
  );
  const plan = 'SSABA';
  assert.deepEqual(live.evaluate(plan), replayed.evaluate(plan));
});

test('undo k restores a consistent snapshot', () => {
  const lib = applyEntries(LOG);
  const before = lib.snapshotHash();
  lib.undo(1); // undo the redo of "del a" -> a is back
  const withA = lib.snapshotHash();
  lib.redo(1);
  assert.equal(lib.snapshotHash(), before);
  lib.undo(1);
  assert.equal(lib.snapshotHash(), withA);
  assert.ok(lib.rules.has('a'));
});

test('undo/redo via jsonl engine matches direct API use', () => {
  const text = LOG.map((e) => JSON.stringify(e)).join('\n');
  const viaLog = runRulesLog(text);
  const viaApi = applyEntries(LOG);
  assert.equal(viaLog.snapshotHash(), viaApi.snapshotHash());
});

test('undo out of bounds is rejected without touching state', () => {
  const lib = applyEntries([{ op: 'add', id: 'a', kind: 'red', pattern: 'AB' }]);
  const hash = lib.snapshotHash();
  assert.throws(() => lib.undo(2), /undo out of bounds/);
  assert.equal(lib.snapshotHash(), hash);
});

test('a failing layer does not pollute the library or history', () => {
  const lib = applyEntries([{ op: 'add', id: 'ok', kind: 'red', pattern: 'AB' }]);
  const hash = lib.snapshotHash();
  const depth = lib.history.length;
  // Batch layer: first op valid, second has a syntax error -> whole layer
  // must be rejected; the first rule must not appear.
  assert.throws(() =>
    lib.applyLayer([
      { type: 'add', id: 'new1', kind: 'yellow', pattern: 'S' },
      { type: 'add', id: 'new2', kind: 'red', pattern: 'A(' },
    ])
  );
  assert.equal(lib.snapshotHash(), hash);
  assert.equal(lib.history.length, depth);
  assert.ok(!lib.rules.has('new1'));
  // Batch with unknown id delete also rolls back.
  assert.throws(() =>
    lib.applyLayer([
      { type: 'del', id: 'ok' },
      { type: 'del', id: 'ghost' },
    ])
  );
  assert.ok(lib.rules.has('ok'));
  assert.equal(lib.snapshotHash(), hash);
  assert.equal(lib.history.length, depth);
});
