'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createArchive, planRepair, verifyArchive } = require('../lib/archive');
const { tmpdir, corruptByte } = require('../testutil/helpers');

const BUFFERS = [Buffer.alloc(8, 1), Buffer.alloc(8, 2), Buffer.alloc(8, 3)];

test('acceptance 5: no damage produces an empty plan', () => {
  const root = tmpdir();
  const arc = path.join(root, 'arc');
  createArchive(arc, BUFFERS);
  const plan = planRepair(arc, path.join(root, 'good-does-not-exist'), 1024);
  assert.deepEqual(plan.repairs, []);
  assert.deepEqual(plan.skipped, []);
  assert.equal(plan.budget.usedBytes, 0);
  assert.equal(plan.budget.maxBytes, 1024);
  assert.equal(verifyArchive(arc).ok, true);
});

test('plan output is deterministic across runs', () => {
  const root = tmpdir();
  const arc = path.join(root, 'arc');
  const good = path.join(root, 'good');
  createArchive(arc, BUFFERS);
  createArchive(good, BUFFERS);
  corruptByte(arc, 2, 0);
  corruptByte(arc, 0, 0);
  const first = JSON.stringify(planRepair(arc, good, 1024));
  const second = JSON.stringify(planRepair(arc, good, 1024));
  assert.equal(first, second);
});

test('repairs are sorted by block index regardless of corruption order', () => {
  const root = tmpdir();
  const arc = path.join(root, 'arc');
  const good = path.join(root, 'good');
  createArchive(arc, BUFFERS);
  createArchive(good, BUFFERS);
  corruptByte(arc, 2, 0);
  corruptByte(arc, 0, 0);
  corruptByte(arc, 1, 0);
  const plan = planRepair(arc, good, 1024);
  assert.deepEqual(plan.repairs.map((r) => r.index), [0, 1, 2]);
  const indices = plan.repairs.map((r) => r.index);
  const sorted = indices.slice().sort((a, b) => a - b);
  assert.deepEqual(indices, sorted);
});

test('plan entries carry length, sha256, source and bytes', () => {
  const root = tmpdir();
  const arc = path.join(root, 'arc');
  const good = path.join(root, 'good');
  createArchive(arc, BUFFERS);
  createArchive(good, BUFFERS);
  corruptByte(arc, 1, 3);
  const plan = planRepair(arc, good, 1024);
  assert.equal(plan.version, 1);
  assert.equal(plan.repairs.length, 1);
  const r = plan.repairs[0];
  assert.equal(r.index, 1);
  assert.equal(r.length, 8);
  assert.equal(r.bytes, 8);
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
  assert.ok(path.isAbsolute(r.source));
});
