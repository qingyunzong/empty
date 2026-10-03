import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  commit,
  recover,
  verify,
  readLog,
  logPath,
  emptyState,
  applyEvent,
} from '../src/store.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sg-store-'));
}

test('commit appends hash-chained records and writes checkpoint', () => {
  const dir = tmpdir();
  commit(dir, { op: 'add-edge', from: 'A', to: 'B' });
  commit(dir, { op: 'add-edge', from: 'B', to: 'A' });
  const records = readLog(dir);
  assert.equal(records.length, 2);
  assert.equal(records[1].prevHash, records[0].hash);
  const report = verify(dir);
  assert.equal(report.ok, true);
  assert.equal(report.events, 2);
  assert.deepEqual(report.components.map((c) => [...c].sort()), [['A', 'B']]);
});

test('delete-edge removes the edge from state', () => {
  const dir = tmpdir();
  commit(dir, { op: 'add-edge', from: 'A', to: 'B' });
  commit(dir, { op: 'delete-edge', from: 'A', to: 'B' });
  const { state } = recover(dir);
  assert.equal(state.edges.size, 0);
  assert.equal(state.appliedCount, 2);
});

test('applyEvent increments appliedCount exactly once per event', () => {
  const state = emptyState();
  applyEvent(state, { op: 'add-edge', from: 'X', to: 'Y' });
  applyEvent(state, { op: 'add-edge', from: 'X', to: 'Y' });
  assert.equal(state.appliedCount, 2);
  assert.equal(state.edges.size, 1);
});

test('tampering any log record breaks verification', () => {
  const dir = tmpdir();
  commit(dir, { op: 'add-edge', from: 'A', to: 'B' });
  commit(dir, { op: 'add-edge', from: 'B', to: 'C' });
  const text = fs.readFileSync(logPath(dir), 'utf8');
  const idx = text.indexOf('"from"') + 8;
  const ch = text[idx];
  const flipped = text.slice(0, idx) + (ch === 'A' ? 'B' : 'A') + text.slice(idx + 1);
  fs.writeFileSync(logPath(dir), flipped);
  assert.throws(() => verify(dir), /hash chain broken/);
});
