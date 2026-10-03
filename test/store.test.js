import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../src/store.js';
import { netRequirements } from '../src/mrp.js';
import {
  scenario2Setup, scenario2Correct, scenario2BadCorrect,
  scenario3Setup, scenario3Update,
} from './fixtures.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mrp-store-'));
}

test('scenario 2: inventory null -> 0 flips net from null to definite shortage', () => {
  const dir = tmpdir();
  store.apply(dir, scenario2Setup);
  let { state } = store.recover(dir);
  assert.equal(netRequirements(state).net.C9, null, 'unknown inventory => null net');

  store.apply(dir, scenario2Correct);
  ({ state } = store.recover(dir));
  assert.equal(netRequirements(state).net.C9, 5, 'qty 0 => shortage of 5');

  // Correction undoes old value by key in the append-only log.
  const log = store.loadLog(dir);
  const corr = log.find((e) => e.op === 'correct');
  assert.deepEqual(corr.old, { component: 'C9', qty: null });
  assert.deepEqual(corr.new, { component: 'C9', qty: 0 });
});

test('scenario 2: correcting an unknown key fails and persists nothing', () => {
  const dir = tmpdir();
  store.apply(dir, scenario2Setup);
  const before = fs.readFileSync(store.logPath(dir), 'utf8');
  assert.throws(() => store.apply(dir, scenario2BadCorrect), /unknown key/);
  assert.equal(fs.readFileSync(store.logPath(dir), 'utf8'), before);
  assert.equal(store.recover(dir).version, 1);
});

test('insert duplicate key and delete unknown key are rejected', () => {
  const dir = tmpdir();
  store.apply(dir, scenario3Setup);
  assert.throws(
    () => store.apply(dir, [{ op: 'insert', entity: 'workorder', key: { id: 'WO1' }, value: { product: 'P', qty: 1 } }]),
    /already exists/,
  );
  assert.throws(
    () => store.apply(dir, [{ op: 'delete', entity: 'inventory', key: { component: 'ZZ' } }]),
    /unknown key/,
  );
});

test('delete removes rows and is replayable', () => {
  const dir = tmpdir();
  store.apply(dir, scenario3Setup);
  store.apply(dir, [{ op: 'delete', entity: 'inventory', key: { component: 'C1' } }]);
  const { state, version } = store.recover(dir);
  assert.equal(version, 2);
  assert.equal(netRequirements(state).net.C1, null, 'deleted inventory row => unknown');
});

test('scenario 3: --fail before_append leaves no effect', () => {
  const dir = tmpdir();
  store.apply(dir, scenario3Setup);
  const logBefore = fs.readFileSync(store.logPath(dir), 'utf8');
  const snapBefore = fs.readFileSync(store.snapshotPath(dir), 'utf8');
  assert.throws(() => store.apply(dir, scenario3Update, { fail: 'before_append' }), /before_append/);
  assert.equal(fs.readFileSync(store.logPath(dir), 'utf8'), logBefore);
  assert.equal(fs.readFileSync(store.snapshotPath(dir), 'utf8'), snapBefore);
  const { state, version } = store.recover(dir);
  assert.equal(version, 1);
  assert.equal(netRequirements(state).net.C1, 5);
});

test('scenario 3: --fail after_append persists log, query replays to recover', () => {
  const dir = tmpdir();
  store.apply(dir, scenario3Setup);
  assert.throws(() => store.apply(dir, scenario3Update, { fail: 'after_append' }), /after_append/);

  // Log has the event (v=2) but snapshot is stale (v=1).
  assert.equal(store.maxVersion(store.loadLog(dir)), 2);
  assert.equal(store.loadSnapshot(dir).version, 1);

  // Restart: recovery replays the tail of the log.
  const { state, version, recovered } = store.recover(dir);
  assert.equal(recovered, true);
  assert.equal(version, 2);
  assert.equal(netRequirements(state).net.C1, -4, 'gross 6 - on-hand 10');
  assert.equal(store.loadSnapshot(dir).version, 2, 'snapshot rewritten after replay');

  // Deltas vs previous version: net 5 -> -4, a negative increment of -9.
  const entries = store.loadLog(dir);
  const prev = netRequirements(store.replayState(entries, 1)).net;
  const curr = netRequirements(store.replayState(entries, 2)).net;
  const deltas = store.netDeltas(prev, curr);
  assert.deepEqual(deltas.negative, { C1: -9 });
  assert.deepEqual(deltas.positive, {});
});

test('hash certificate changes with each appended batch', () => {
  const dir = tmpdir();
  const h0 = store.logHash(dir);
  store.apply(dir, scenario3Setup);
  const h1 = store.logHash(dir);
  store.apply(dir, scenario3Update);
  const h2 = store.logHash(dir);
  assert.notEqual(h0, h1);
  assert.notEqual(h1, h2);
  assert.match(h2, /^sha256:[0-9a-f]{64}$/);
});
