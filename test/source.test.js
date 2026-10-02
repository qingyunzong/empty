'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createArchive, planRepair, readManifest } = require('../lib/archive');
const { tmpdir, corruptByte } = require('../testutil/helpers');

const BUFFERS = [Buffer.alloc(8, 1), Buffer.alloc(8, 2), Buffer.alloc(8, 3)];

function makeArc(root) {
  const arc = path.join(root, 'arc');
  createArchive(arc, BUFFERS);
  corruptByte(arc, 1, 0);
  return arc;
}

function claimHash(dir, index, sha256) {
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.blocks[index].sha256 = sha256;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

test('acceptance 3: two candidate sources with same claimed hash but different content raise ERR_SOURCE', () => {
  const root = tmpdir();
  const arc = makeArc(root);
  const expected = readManifest(arc).blocks[1].sha256;

  const good = path.join(root, 'good');
  const srcA = path.join(good, 'srcA');
  const srcB = path.join(good, 'srcB');
  createArchive(srcA, BUFFERS);
  createArchive(srcB, [Buffer.alloc(8, 1), Buffer.alloc(8, 9), Buffer.alloc(8, 3)]);
  claimHash(srcB, 1, expected);

  assert.throws(() => planRepair(arc, good, 1024), (e) => {
    assert.equal(e.code, 'ERR_SOURCE');
    assert.match(e.message, /conflicting sources for block 1/);
    return true;
  });
});

test('conflict is detected even when one source holds the correct content', () => {
  const root = tmpdir();
  const arc = makeArc(root);
  const expected = readManifest(arc).blocks[1].sha256;

  const good = path.join(root, 'good');
  createArchive(path.join(good, 'a-good'), BUFFERS);
  const liar = path.join(good, 'b-liar');
  createArchive(liar, [Buffer.alloc(8, 1), Buffer.alloc(8, 7), Buffer.alloc(8, 3)]);
  claimHash(liar, 1, expected);

  assert.throws(() => planRepair(arc, good, 1024), (e) => e.code === 'ERR_SOURCE');
});

test('a single consistent source is used and verified against the strong hash', () => {
  const root = tmpdir();
  const arc = makeArc(root);
  const good = path.join(root, 'good');
  createArchive(good, BUFFERS);
  const plan = planRepair(arc, good, 1024);
  assert.deepEqual(plan.repairs.map((r) => r.index), [1]);
  assert.equal(plan.repairs[0].sha256, readManifest(arc).blocks[1].sha256);
});

test('a single source whose content does not match its claimed hash is skipped as no-source', () => {
  const root = tmpdir();
  const arc = makeArc(root);
  const expected = readManifest(arc).blocks[1].sha256;
  const good = path.join(root, 'good');
  createArchive(good, [Buffer.alloc(8, 1), Buffer.alloc(8, 7), Buffer.alloc(8, 3)]);
  claimHash(good, 1, expected);
  const plan = planRepair(arc, good, 1024);
  assert.deepEqual(plan.repairs, []);
  assert.deepEqual(plan.skipped, [{ index: 1, reason: 'no-source' }]);
});

test('identical redundant sources are fine and the choice is deterministic', () => {
  const root = tmpdir();
  const arc = makeArc(root);
  const good = path.join(root, 'good');
  createArchive(path.join(good, 'z-copy'), BUFFERS);
  createArchive(path.join(good, 'a-copy'), BUFFERS);
  const plan1 = planRepair(arc, good, 1024);
  const plan2 = planRepair(arc, good, 1024);
  assert.equal(plan1.repairs.length, 1);
  assert.ok(plan1.repairs[0].source.includes('a-copy'));
  assert.equal(JSON.stringify(plan1), JSON.stringify(plan2));
});

test('missing known-good directory raises ERR_IO when repairs are needed', () => {
  const root = tmpdir();
  const arc = makeArc(root);
  assert.throws(() => planRepair(arc, path.join(root, 'nope'), 1024), (e) => e.code === 'ERR_IO');
});
