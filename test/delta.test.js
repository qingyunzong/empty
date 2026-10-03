'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { scanDir, sha256 } = require('../lib/manifest');
const { makeDelta } = require('../lib/delta');
const { applyDelta } = require('../lib/apply');
const { certify } = require('../lib/certify');
const { tmpdir, writeTree, treesEqual, dirReader } = require('./helpers');

const CHUNK = 16;

function setupTrees(srcFiles, tgtFiles) {
  const base = tmpdir();
  const src = path.join(base, 'src');
  const tgt = path.join(base, 'tgt');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(tgt, { recursive: true });
  writeTree(src, srcFiles);
  writeTree(tgt, tgtFiles);
  return { base, src, tgt };
}

test('1: small tree add/delete/modify round-trips byte-for-byte', () => {
  const cbin = Buffer.alloc(100);
  for (let i = 0; i < cbin.length; i++) cbin[i] = i % 251;
  const cbin2 = Buffer.from(cbin);
  cbin2[40] = 0xff;
  cbin2[41] = 0xfe;

  const { src, tgt } = setupTrees(
    {
      'a.txt': 'hello world, this will be modified',
      'keep.txt': 'identical in both trees',
      'sub/b.txt': 'this file gets deleted',
      'sub/c.bin': cbin,
    },
    {
      'a.txt': 'hello brave new world, modified!',
      'keep.txt': 'identical in both trees',
      'sub/c.bin': cbin2,
      'new/d.txt': 'brand new file added in target',
      'new/e.txt': 'identical in both trees',
    }
  );

  const srcM = scanDir(src, { chunkSize: CHUNK });
  const tgtM = scanDir(tgt, { chunkSize: CHUNK });
  const delta = makeDelta(srcM, tgtM, dirReader(tgt));

  assert.deepEqual(delta.deletes, ['sub/b.txt']);
  assert.equal(delta.baseRoot, srcM.root);
  assert.equal(delta.targetRoot, tgtM.root);

  const work = path.join(src, '..', 'work');
  fs.cpSync(src, work, { recursive: true });

  const res = applyDelta(delta, work);
  assert.equal(res.status, 'applied');
  assert.equal(res.root, tgtM.root);

  assert.ok(treesEqual(work, tgt), 'applied tree must equal target tree byte-for-byte');

  const cert = certify(work, delta);
  assert.equal(cert.root, tgtM.root);
  assert.equal(cert.coverage, 'complete');
  assert.equal(cert.files, 5);
});

test('2: duplicate content stored once with correct reference counts', () => {
  const block = 'ABCDEFGHIJKLMNOP'; // exactly one chunk
  const repeated = block.repeat(4); // 4 identical chunks in one file

  const { src, tgt } = setupTrees(
    { 'seed.txt': block },
    {
      'seed.txt': block,
      'copy1.txt': block,
      'copy2.txt': block,
      'multi.bin': repeated,
      'fresh1.txt': 'totally new content A',
      'fresh2.txt': 'totally new content A',
    }
  );

  const srcM = scanDir(src, { chunkSize: CHUNK });
  const tgtM = scanDir(tgt, { chunkSize: CHUNK });
  const delta = makeDelta(srcM, tgtM, dirReader(tgt));

  const seedHash = sha256(Buffer.from(block));
  assert.equal(Object.keys(delta.reuse).length, 1);
  assert.equal(delta.reuse[seedHash].refs, 7, 'seed block referenced by 3 files + 4 chunks of multi.bin');
  assert.equal(delta.reuse[seedHash].path, 'seed.txt');
  assert.equal(delta.reuse[seedHash].offset, 0);

  const freshHash = sha256(Buffer.from('totally new cont'));
  const freshHash2 = sha256(Buffer.from('ent A'));
  assert.equal(Object.keys(delta.literals).length, 2);
  assert.equal(delta.literals[freshHash].refs, 2);
  assert.equal(delta.literals[freshHash2].refs, 2);
  assert.equal(
    Buffer.from(delta.literals[freshHash].data, 'base64').toString(),
    'totally new cont'
  );

  const work = path.join(src, '..', 'work');
  fs.cpSync(src, work, { recursive: true });
  applyDelta(delta, work);
  assert.ok(treesEqual(work, tgt));
});

test('5: empty-to-empty delta has deterministic root', () => {
  const { src, tgt } = setupTrees({}, {});
  const srcM = scanDir(src, { chunkSize: CHUNK });
  const tgtM = scanDir(tgt, { chunkSize: CHUNK });

  assert.equal(srcM.root, tgtM.root);
  assert.equal(srcM.root, sha256(Buffer.alloc(0)), 'empty tree root is sha256 of empty input');

  const delta1 = makeDelta(srcM, tgtM, dirReader(tgt));
  const delta2 = makeDelta(scanDir(src, { chunkSize: CHUNK }), scanDir(tgt, { chunkSize: CHUNK }), dirReader(tgt));
  assert.equal(JSON.stringify(delta1), JSON.stringify(delta2), 'delta generation is deterministic');
  assert.equal(delta1.baseRoot, delta1.targetRoot);
  assert.deepEqual(delta1.deletes, []);
  assert.deepEqual(delta1.files, []);

  const res = applyDelta(delta1, src);
  assert.equal(res.status, 'already-applied');

  const cert = certify(src, delta1);
  assert.equal(cert.root, srcM.root);
  assert.equal(cert.files, 0);
  assert.equal(cert.bytes, 0);
  assert.equal(cert.coverage, 'complete');
});

test('5b: empty-to-nonempty and nonempty-to-empty deltas', () => {
  const { src, tgt } = setupTrees({}, { 'only.txt': 'appeared out of nowhere, more than one chunk!' });
  const srcM = scanDir(src, { chunkSize: CHUNK });
  const tgtM = scanDir(tgt, { chunkSize: CHUNK });
  const delta = makeDelta(srcM, tgtM, dirReader(tgt));
  applyDelta(delta, src);
  assert.ok(treesEqual(src, tgt));

  const back = makeDelta(tgtM, srcM, dirReader(src));
  assert.deepEqual(back.deletes, ['only.txt']);
  applyDelta(back, tgt);
  assert.equal(scanDir(tgt, { chunkSize: CHUNK }).root, srcM.root);
});
