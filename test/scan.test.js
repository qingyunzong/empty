'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { scanDir, normalizePath, sha256 } = require('../lib/manifest');
const { coverageProof } = require('../lib/certify');
const { tmpdir, writeTree } = require('./helpers');

test('4a: case-conflicting file names are rejected with ERR_PATH', () => {
  const dir = tmpdir();
  writeTree(dir, { 'Foo.txt': 'one', 'foo.txt': 'two' });
  assert.throws(() => scanDir(dir), (e) => e.code === 'ERR_PATH');
});

test('4b: case-conflicting directory names are rejected with ERR_PATH', () => {
  const dir = tmpdir();
  writeTree(dir, { 'Data/a.txt': 'x', 'data/b.txt': 'y' });
  assert.throws(() => scanDir(dir), (e) => e.code === 'ERR_PATH');
});

test('4c: backslash and NUL in file names are rejected with ERR_PATH', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'back\\slash.txt'), 'x');
  assert.throws(() => scanDir(dir), (e) => e.code === 'ERR_PATH');
});

test('4d: symlinks are rejected with ERR_PATH', () => {
  const dir = tmpdir();
  writeTree(dir, { 'real.txt': 'x' });
  fs.symlinkSync(path.join(dir, 'real.txt'), path.join(dir, 'link.txt'));
  assert.throws(() => scanDir(dir), (e) => e.code === 'ERR_PATH');
});

test('4e: normalizePath rejects illegal paths', () => {
  const bad = ['', '/abs', 'a//b', './a', 'a/./b', '..', 'a/../b', 'a\\b', 'nul\0x'];
  for (const p of bad) {
    assert.throws(() => normalizePath(p), (e) => e.code === 'ERR_PATH', JSON.stringify(p));
  }
  assert.equal(normalizePath('a/b/c.txt'), 'a/b/c.txt');
});

test('scan is deterministic and chunk entries carry path/mode/offset/sha256', () => {
  const dir = tmpdir();
  writeTree(dir, { 'a.txt': 'content of a, more than one chunk', 'sub/b.txt': 'b content' });
  const m1 = scanDir(dir, { chunkSize: 8 });
  const m2 = scanDir(dir, { chunkSize: 8 });
  assert.equal(JSON.stringify(m1), JSON.stringify(m2));
  for (const f of m1.files) {
    for (const c of f.chunks) {
      assert.equal(c.path, f.path);
      assert.equal(c.mode, f.mode);
      assert.equal(typeof c.offset, 'number');
      assert.match(c.sha256, /^[0-9a-f]{64}$/);
    }
  }
  const a = m1.files.find((f) => f.path === 'a.txt');
  assert.equal(a.chunks[0].offset, 0);
  assert.equal(a.chunks[1].offset, 8);
  assert.equal(a.chunks[0].sha256, sha256(Buffer.from('content ')));
});

test('certify reports ERR_GAP for uncovered bytes', () => {
  const manifest = {
    version: 1,
    chunkSize: 8,
    root: 'x',
    files: [
      {
        path: 'a.txt',
        mode: 420,
        size: 16,
        chunks: [
          { path: 'a.txt', mode: 420, offset: 0, size: 8, sha256: 'a'.repeat(64) },
          // missing chunk at offset 8
        ],
      },
    ],
  };
  assert.throws(() => coverageProof(manifest), (e) => e.code === 'ERR_GAP');

  manifest.files[0].chunks.push({ path: 'a.txt', mode: 420, offset: 4, size: 12, sha256: 'b'.repeat(64) });
  assert.throws(() => coverageProof(manifest), (e) => e.code === 'ERR_GAP', 'overlap also rejected');
});
