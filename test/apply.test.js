'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createArchive,
  planRepair,
  applyPlan,
  verifyArchive,
} = require('../lib/archive');
const { tmpdir, corruptByte, blockFile, snapshotTree, leftoverTempFiles } = require('../testutil/helpers');

const BUFFERS = [Buffer.alloc(16, 1), Buffer.alloc(16, 2), Buffer.alloc(16, 3)];

function setup(damage = [0, 1]) {
  const root = tmpdir();
  const arc = path.join(root, 'arc');
  const good = path.join(root, 'good');
  createArchive(arc, BUFFERS);
  createArchive(good, BUFFERS);
  for (const i of damage) corruptByte(arc, i, 0);
  return { root, arc, good };
}

function failingFs(failOnCall, method) {
  let calls = 0;
  return new Proxy(fs, {
    get(target, prop) {
      if (prop === method) {
        return (...args) => {
          calls++;
          if (calls === failOnCall) {
            const err = new Error('injected write failure');
            err.code = 'EIO';
            throw err;
          }
          return target[method](...args);
        };
      }
      return target[prop];
    },
  });
}

test('applyPlan repairs damaged blocks and verify passes', () => {
  const { arc, good } = setup([0, 2]);
  const plan = planRepair(arc, good, 1024);
  assert.deepEqual(plan.repairs.map((r) => r.index), [0, 2]);
  const result = applyPlan(arc, plan);
  assert.equal(result.applied, 2);
  assert.equal(result.bytes, 32);
  const check = verifyArchive(arc);
  assert.equal(check.ok, true);
  for (let i = 0; i < BUFFERS.length; i++) {
    assert.ok(fs.readFileSync(blockFile(arc, i)).equals(BUFFERS[i]));
  }
  assert.deepEqual(leftoverTempFiles(arc), []);
});

test('applyPlan accepts a plan file path', () => {
  const { root, arc, good } = setup([1]);
  const plan = planRepair(arc, good, 1024);
  const planFile = path.join(root, 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
  const result = applyPlan(arc, planFile);
  assert.equal(result.applied, 1);
  assert.equal(verifyArchive(arc).ok, true);
});

test('acceptance 4: injected write failure during staging rolls back atomically', () => {
  const { arc, good } = setup([0, 1]);
  const before = snapshotTree(arc);
  const plan = planRepair(arc, good, 1024);
  assert.equal(plan.repairs.length, 2);

  const fsx = failingFs(2, 'writeSync');
  assert.throws(() => applyPlan(arc, plan, fsx), (e) => e.code === 'ERR_IO');

  assert.deepEqual(snapshotTree(arc), before, 'archive must be byte-identical after rollback');
  assert.deepEqual(leftoverTempFiles(arc), [], 'no temp files left behind');
});

test('acceptance 4: injected failure on the first staged write leaves archive untouched', () => {
  const { arc, good } = setup([0, 1]);
  const before = snapshotTree(arc);
  const plan = planRepair(arc, good, 1024);

  const fsx = failingFs(1, 'writeSync');
  assert.throws(() => applyPlan(arc, plan, fsx), (e) => e.code === 'ERR_IO');

  assert.deepEqual(snapshotTree(arc), before);
  assert.deepEqual(leftoverTempFiles(arc), []);
});

test('acceptance 4: injected failure during commit phase restores originals', () => {
  const { arc, good } = setup([0, 1]);
  const before = snapshotTree(arc);
  const plan = planRepair(arc, good, 1024);

  const fsx = failingFs(3, 'renameSync');
  assert.throws(() => applyPlan(arc, plan, fsx), (e) => e.code === 'ERR_IO');

  assert.deepEqual(snapshotTree(arc), before, 'commit-phase failure must restore originals');
  assert.deepEqual(leftoverTempFiles(arc), []);
});

test('applyPlan rejects a tampered source with ERR_SOURCE and changes nothing', () => {
  const { arc, good } = setup([0]);
  const before = snapshotTree(arc);
  const plan = planRepair(arc, good, 1024);
  fs.writeFileSync(plan.repairs[0].source, Buffer.alloc(16, 99));
  assert.throws(() => applyPlan(arc, plan), (e) => e.code === 'ERR_SOURCE');
  assert.deepEqual(snapshotTree(arc), before);
});

test('applyPlan rejects a plan that exceeds its budget with ERR_BUDGET', () => {
  const { arc, good } = setup([0]);
  const plan = planRepair(arc, good, 1024);
  plan.budget.maxBytes = 1;
  assert.throws(() => applyPlan(arc, plan), (e) => e.code === 'ERR_BUDGET');
});

test('applyPlan rejects a plan that does not match the archive with ERR_CRC', () => {
  const { arc, good } = setup([0]);
  const plan = planRepair(arc, good, 1024);
  plan.repairs[0].sha256 = '0'.repeat(64);
  plan.repairs[0].length = 16;
  assert.throws(() => applyPlan(arc, plan), (e) => e.code === 'ERR_CRC');
});

test('applyPlan rejects unsorted repairs', () => {
  const { arc, good } = setup([0, 1]);
  const plan = planRepair(arc, good, 1024);
  plan.repairs.reverse();
  assert.throws(() => applyPlan(arc, plan), (e) => e.code === 'ERR_CRC');
});
