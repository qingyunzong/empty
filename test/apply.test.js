'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { scanDir } = require('../lib/manifest');
const { makeDelta } = require('../lib/delta');
const { applyDelta } = require('../lib/apply');
const { certify } = require('../lib/certify');
const { tmpdir, writeTree, readTree, treesEqual, dirReader } = require('./helpers');

const CHUNK = 16;

function buildDelta() {
  const base = tmpdir();
  const src = path.join(base, 'src');
  const tgt = path.join(base, 'tgt');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(tgt, { recursive: true });
  writeTree(src, {
    'a.txt': 'first file, will be replaced with something longer',
    'gone.txt': 'deleted in target',
    'dir/keep.txt': 'kept as-is',
  });
  writeTree(tgt, {
    'a.txt': 'REPLACED content that is quite a bit longer than before, spanning chunks',
    'dir/keep.txt': 'kept as-is',
    'dir/new/nested.txt': 'new nested file appearing in target tree',
  });
  const srcM = scanDir(src, { chunkSize: CHUNK });
  const tgtM = scanDir(tgt, { chunkSize: CHUNK });
  const delta = makeDelta(srcM, tgtM, dirReader(tgt));
  return { base, src, tgt, srcM, tgtM, delta };
}

test('3: interrupted apply (after journal) recovers on next run', () => {
  const { src, tgt, delta } = buildDelta();
  const work = path.join(src, '..', 'work');
  fs.cpSync(src, work, { recursive: true });
  const before = readTree(work);

  process.env.DELTA_APPLY_FAIL = 'after-journal';
  assert.throws(() => applyDelta(delta, work), /injected apply failure/);
  delete process.env.DELTA_APPLY_FAIL;

  assert.ok(fs.existsSync(path.join(work, '.delta-apply.journal')), 'journal survives crash');
  assert.deepEqual(readTree(work), before, 'target tree untouched by failed apply');

  // recovery rolls the interrupted apply forward, so the retry reports
  // that the target state is already reached
  const res = applyDelta(delta, work);
  assert.equal(res.status, 'already-applied');
  assert.ok(treesEqual(work, tgt), 'recovered apply matches target');
  assert.ok(!fs.existsSync(path.join(work, '.delta-apply.journal')), 'journal cleaned up');

  const cert = certify(work, delta);
  assert.equal(cert.root, delta.targetRoot);
});

test('3b: stale staging without journal is discarded, target untouched', () => {
  const { src, tgt, delta } = buildDelta();
  const work = path.join(src, '..', 'work');
  fs.cpSync(src, work, { recursive: true });

  const staging = path.join(work, '.delta-apply-staging');
  fs.mkdirSync(path.join(staging, 'junk'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'junk', 'partial.bin'), 'half-written');

  const res = applyDelta(delta, work);
  assert.equal(res.status, 'applied');
  assert.ok(treesEqual(work, tgt));
  assert.ok(!fs.existsSync(staging));
});

test('3c: apply is idempotent', () => {
  const { src, tgt, delta } = buildDelta();
  const work = path.join(src, '..', 'work');
  fs.cpSync(src, work, { recursive: true });
  applyDelta(delta, work);
  const again = applyDelta(delta, work);
  assert.equal(again.status, 'already-applied');
  assert.ok(treesEqual(work, tgt));
});

test('3d: wrong base state is rejected with ERR_STATE', () => {
  const { tgt, delta } = buildDelta();
  const work = path.join(tgt, '..', 'work');
  fs.cpSync(tgt, work, { recursive: true });
  fs.writeFileSync(path.join(work, 'extra.txt'), 'not part of base');
  assert.throws(() => applyDelta(delta, work), (e) => e.code === 'ERR_STATE');
});

test('3e: tampered literal chunk fails with ERR_HASH and does not pollute target', () => {
  const { src, delta } = buildDelta();
  const work = path.join(src, '..', 'work');
  fs.cpSync(src, work, { recursive: true });
  const before = readTree(work);

  const tampered = JSON.parse(JSON.stringify(delta));
  const hash = Object.keys(tampered.literals)[0];
  tampered.literals[hash].data = Buffer.from('evil evil evil e').toString('base64');

  assert.throws(() => applyDelta(tampered, work), (e) => e.code === 'ERR_HASH');
  assert.deepEqual(readTree(work), before, 'target tree untouched after hash failure');
  assert.ok(!fs.existsSync(path.join(work, '.delta-apply-staging')));
  assert.ok(!fs.existsSync(path.join(work, '.delta-apply.journal')));
});

test('4: delta with illegal paths is rejected with ERR_PATH', () => {
  const { src, delta } = buildDelta();
  const work = path.join(src, '..', 'work');
  fs.cpSync(src, work, { recursive: true });

  const badPaths = ['../evil.txt', '/abs.txt', 'a//b.txt', './x.txt', 'a\\b.txt', 'nul\0x'];
  for (const bad of badPaths) {
    const crafted = JSON.parse(JSON.stringify(delta));
    crafted.files.push({ path: bad, mode: 420, size: 0, chunks: [] });
    assert.throws(() => applyDelta(crafted, work), (e) => e.code === 'ERR_PATH', `path ${JSON.stringify(bad)}`);
  }

  const conflict = JSON.parse(JSON.stringify(delta));
  conflict.files.push({ path: 'Dir/KEEP.txt', mode: 420, size: 0, chunks: [] });
  assert.throws(() => applyDelta(conflict, work), (e) => e.code === 'ERR_PATH');

  const badDelete = JSON.parse(JSON.stringify(delta));
  badDelete.deletes.push('../../outside.txt');
  assert.throws(() => applyDelta(badDelete, work), (e) => e.code === 'ERR_PATH');
});
