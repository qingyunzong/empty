import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePath } from '../src/index.js';
import { isArchiveError } from '../src/errors.js';
import { slowNormalize } from '../src/slowModel.js';

test('keeps already-clean paths', () => {
  assert.equal(normalizePath('a/b/c'), 'a/b/c');
  assert.equal(normalizePath('single'), 'single');
});

test('eliminates dot segments and empty segments', () => {
  assert.equal(normalizePath('a/./b//c/'), 'a/b/c');
  assert.equal(normalizePath('./a/./b'), 'a/b');
  assert.equal(normalizePath('//a///b//'), 'a/b');
  assert.equal(normalizePath('a/b/./'), 'a/b');
});

test('strips leading slash (paths are archive-root relative)', () => {
  assert.equal(normalizePath('/a/b'), 'a/b');
  assert.equal(normalizePath('/'), '');
  assert.equal(normalizePath(''), '');
});

test('resolves dot-dot against preceding segments', () => {
  assert.equal(normalizePath('a/../b'), 'b');
  assert.equal(normalizePath('a/b/../../c'), 'c');
  assert.equal(normalizePath('a/./b/../c/..'), 'a');
  assert.equal(normalizePath('a/b/../../c/../'), '');
});

test('rejects escaping the archive root', () => {
  for (const p of ['..', '../a', 'a/../..', 'a/../../b', '../../..']) {
    assert.throws(() => normalizePath(p), (err) => isArchiveError(err, 'ESCAPE_ROOT'), p);
  }
});

test('is case-sensitive', () => {
  assert.equal(normalizePath('A/b'), 'A/b');
  assert.notEqual(normalizePath('A/B'), normalizePath('a/b'));
});

test('agrees with the recursive slow model on random paths', () => {
  let seed = 0xC0FFEE;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const segments = ['a', 'b', 'C', '.', '..', '', 'x', 'D'];
  for (let i = 0; i < 5000; i++) {
    const n = Math.floor(rnd() * 6);
    const parts: string[] = [];
    for (let j = 0; j < n; j++) parts.push(segments[Math.floor(rnd() * segments.length)]!);
    const path = parts.join('/');
    let fast: string | null = null;
    let slow: string | null = null;
    try { fast = normalizePath(path); } catch (err) { assert.ok(isArchiveError(err, 'ESCAPE_ROOT')); }
    try { slow = slowNormalize(path); } catch (err) { assert.ok(isArchiveError(err, 'ESCAPE_ROOT')); }
    assert.equal(fast, slow, `mismatch for ${JSON.stringify(path)}`);
  }
});
