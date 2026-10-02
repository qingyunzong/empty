'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createArchive, inspectArchive, readManifest } = require('../lib/archive');
const { adler32hex } = require('../lib/adler32');
const { tmpdir, corruptByte, blockFile } = require('../testutil/helpers');

const BLOCKS = [
  Buffer.from([1, 2, 3, 4]),
  Buffer.from([5, 6, 7]),
  Buffer.from([8, 9, 10, 11, 12]),
];

test('acceptance 1: enumerate every single-byte corruption position against inspect', () => {
  const root = tmpdir();
  const base = path.join(root, 'base');
  createArchive(base, BLOCKS);

  const clean = inspectArchive(base);
  assert.equal(clean.damagedCount, 0);
  assert.deepEqual(clean.damaged, []);

  let checked = 0;
  for (let b = 0; b < BLOCKS.length; b++) {
    for (let pos = 0; pos < BLOCKS[b].length; pos++) {
      const work = path.join(root, `work-${b}-${pos}`);
      fs.cpSync(base, work, { recursive: true });
      corruptByte(work, b, pos);
      const report = inspectArchive(work);
      assert.deepEqual(report.damaged, [b], `block ${b} pos ${pos}`);
      assert.equal(report.details[b].weakOk, false);
      assert.equal(report.details[b].strongOk, false);
      assert.equal(report.details[b].status, 'damaged');
      for (const other of [0, 1, 2].filter((i) => i !== b)) {
        assert.equal(report.details[other].status, 'ok');
      }
      checked++;
    }
  }
  assert.equal(checked, 12);
});

test('multiple damaged blocks are reported sorted by index', () => {
  const root = tmpdir();
  const arc = path.join(root, 'arc');
  createArchive(arc, BLOCKS);
  corruptByte(arc, 2, 0);
  corruptByte(arc, 0, 3);
  const report = inspectArchive(arc);
  assert.deepEqual(report.damaged, [0, 2]);
  assert.equal(report.damagedCount, 2);
});

test('weak mismatch alone is not damage (strong hash still valid)', () => {
  const root = tmpdir();
  const arc = path.join(root, 'arc');
  createArchive(arc, BLOCKS);
  const manifestPath = path.join(arc, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.blocks[1].adler32 = '00000000';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const report = inspectArchive(arc);
  assert.equal(report.details[1].weakOk, false);
  assert.equal(report.details[1].strongOk, true);
  assert.deepEqual(report.damaged, []);
});

test('strong mismatch alone is not damage per the weak+strong rule', () => {
  const root = tmpdir();
  const arc = path.join(root, 'arc');
  createArchive(arc, BLOCKS);
  corruptByte(arc, 1, 0);
  const corrupted = fs.readFileSync(blockFile(arc, 1));
  const manifestPath = path.join(arc, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.blocks[1].adler32 = adler32hex(corrupted);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const report = inspectArchive(arc);
  assert.equal(report.details[1].weakOk, true);
  assert.equal(report.details[1].strongOk, false);
  assert.deepEqual(report.damaged, []);
});

test('missing block file counts as damaged', () => {
  const root = tmpdir();
  const arc = path.join(root, 'arc');
  createArchive(arc, BLOCKS);
  fs.unlinkSync(blockFile(arc, 1));
  const report = inspectArchive(arc);
  assert.deepEqual(report.damaged, [1]);
  assert.equal(report.details[1].missing, true);
});

test('malformed manifest checksum fields raise ERR_CRC', () => {
  const root = tmpdir();
  const arc = path.join(root, 'arc');
  createArchive(arc, BLOCKS);
  const manifestPath = path.join(arc, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.blocks[0].sha256 = 'not-a-hash';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => inspectArchive(arc), (e) => e.code === 'ERR_CRC');
});

test('unreadable manifest raises ERR_IO', () => {
  const root = tmpdir();
  assert.throws(() => inspectArchive(path.join(root, 'nope')), (e) => e.code === 'ERR_IO');
  const arc = path.join(root, 'arc');
  fs.mkdirSync(arc);
  fs.writeFileSync(path.join(arc, 'manifest.json'), '{oops');
  assert.throws(() => inspectArchive(arc), (e) => e.code === 'ERR_IO');
});

test('readManifest validates a well-formed archive', () => {
  const root = tmpdir();
  const arc = path.join(root, 'arc');
  createArchive(arc, BLOCKS);
  const manifest = readManifest(arc);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.blocks.length, 3);
});
