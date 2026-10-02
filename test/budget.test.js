'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createArchive, planRepair } = require('../lib/archive');
const { tmpdir, corruptByte } = require('../testutil/helpers');

const SIZES = [10, 20, 30];
const BUFFERS = SIZES.map((n, i) => Buffer.alloc(n, i + 1));

function setup() {
  const root = tmpdir();
  const arc = path.join(root, 'arc');
  const good = path.join(root, 'good');
  createArchive(arc, BUFFERS);
  createArchive(good, BUFFERS);
  corruptByte(arc, 0, 0);
  corruptByte(arc, 1, 0);
  return { root, arc, good };
}

test('acceptance 2: budget exactly fits the prefix (10 + 20 = 30)', () => {
  const { arc, good } = setup();
  const plan = planRepair(arc, good, 30);
  assert.deepEqual(plan.repairs.map((r) => r.index), [0, 1]);
  assert.equal(plan.budget.usedBytes, 30);
  assert.deepEqual(plan.skipped, []);
});

test('acceptance 2: one byte less (29) drops the block that overflows', () => {
  const { arc, good } = setup();
  const plan = planRepair(arc, good, 29);
  assert.deepEqual(plan.repairs.map((r) => r.index), [0]);
  assert.equal(plan.budget.usedBytes, 10);
  assert.deepEqual(plan.skipped, [{ index: 1, reason: 'budget' }]);
});

test('budget exactly one block (10) repairs only that block', () => {
  const { arc, good } = setup();
  const plan = planRepair(arc, good, 10);
  assert.deepEqual(plan.repairs.map((r) => r.index), [0]);
  assert.equal(plan.budget.usedBytes, 10);
  assert.deepEqual(plan.skipped, [{ index: 1, reason: 'budget' }]);
});

test('budget one byte below the first block (9) repairs nothing', () => {
  const { arc, good } = setup();
  const plan = planRepair(arc, good, 9);
  assert.deepEqual(plan.repairs, []);
  assert.equal(plan.budget.usedBytes, 0);
  assert.deepEqual(plan.skipped, [
    { index: 0, reason: 'budget' },
    { index: 1, reason: 'prefix' },
  ]);
});

test('zero budget yields an empty repair list', () => {
  const { arc, good } = setup();
  const plan = planRepair(arc, good, 0);
  assert.deepEqual(plan.repairs, []);
  assert.equal(plan.budget.usedBytes, 0);
});

test('invalid budgets raise ERR_BUDGET', () => {
  const { arc, good } = setup();
  for (const bad of [-1, 1.5, NaN, Infinity, '1024']) {
    assert.throws(() => planRepair(arc, good, bad), (e) => e.code === 'ERR_BUDGET');
  }
});

test('continuous prefix: a gap stops later blocks even within budget', () => {
  const root = tmpdir();
  const arc = path.join(root, 'arc');
  const good = path.join(root, 'good');
  createArchive(arc, BUFFERS);
  createArchive(good, BUFFERS.slice(0, 2));
  corruptByte(arc, 1, 0);
  corruptByte(arc, 2, 0);
  const plan = planRepair(arc, good, 1000);
  assert.deepEqual(plan.repairs.map((r) => r.index), [1]);
  assert.deepEqual(plan.skipped, [{ index: 2, reason: 'no-source' }]);
});

test('continuous prefix: missing source for the first block blocks the rest', () => {
  const root = tmpdir();
  const arc = path.join(root, 'arc');
  const good = path.join(root, 'good');
  createArchive(arc, BUFFERS);
  createArchive(good, BUFFERS.slice(1));
  corruptByte(arc, 0, 0);
  corruptByte(arc, 1, 0);
  const plan = planRepair(arc, good, 1000);
  assert.deepEqual(plan.repairs, []);
  assert.deepEqual(plan.skipped, [
    { index: 0, reason: 'no-source' },
    { index: 1, reason: 'prefix' },
  ]);
});
