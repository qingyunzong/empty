import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildIndex } from '../src/index';

test('relative targets resolve against the link parent directory', () => {
  const index = buildIndex([
    { path: 'dir/link', type: 'symlink', target: '../sibling.txt' },
    { path: 'sibling.txt', type: 'file' },
  ]);
  assert.deepEqual(index.get('dir/link'), {
    type: 'symlink',
    path: 'dir/link',
    target: 'sibling.txt',
  });
  assert.deepEqual(index.resolve('dir/link'), { ok: true, path: 'sibling.txt' });
});

test('absolute targets resolve against the archive root', () => {
  const index = buildIndex([
    { path: 'dir/link', type: 'symlink', target: '/etc/passwd' },
    { path: 'etc/passwd', type: 'file' },
  ]);
  assert.deepEqual(index.resolve('dir/link'), { ok: true, path: 'etc/passwd' });
});

test('targets are normalized before expansion', () => {
  const index = buildIndex([
    { path: 'link', type: 'symlink', target: 'a/./b/../c' },
    { path: 'a/c', type: 'file' },
  ]);
  assert.deepEqual(index.resolve('link'), { ok: true, path: 'a/c' });
});

test('chains of symlinks expand to the final target', () => {
  const index = buildIndex([
    { path: 'a', type: 'symlink', target: 'b' },
    { path: 'b', type: 'symlink', target: 'c/d' },
    { path: 'c/d', type: 'file' },
  ]);
  assert.deepEqual(index.resolve('a'), { ok: true, path: 'c/d' });
  assert.deepEqual(index.resolve('b'), { ok: true, path: 'c/d' });
});

test('dangling links resolve to the normalized target path', () => {
  const index = buildIndex([
    { path: 'link', type: 'symlink', target: 'missing' },
  ]);
  assert.deepEqual(index.resolve('link'), { ok: true, path: 'missing' });
});

test('resolving a non-symlink returns its normalized path', () => {
  const index = buildIndex([{ path: 'a/b.txt', type: 'file' }]);
  assert.deepEqual(index.resolve('a//./b.txt'), { ok: true, path: 'a/b.txt' });
  assert.deepEqual(index.resolve('not/there'), { ok: true, path: 'not/there' });
});

test('self-referential link yields a one-node cycle', () => {
  const index = buildIndex([
    { path: 'loop', type: 'symlink', target: 'loop' },
  ]);
  assert.deepEqual(index.resolve('loop'), { ok: false, cycle: ['loop'] });
});

test('two-node cycle returns both links in order', () => {
  const index = buildIndex([
    { path: 'a', type: 'symlink', target: 'b' },
    { path: 'b', type: 'symlink', target: 'a' },
  ]);
  assert.deepEqual(index.resolve('a'), { ok: false, cycle: ['a', 'b'] });
  assert.deepEqual(index.resolve('b'), { ok: false, cycle: ['b', 'a'] });
});

test('cycle returns the shortest repeated chain, not the prefix', () => {
  const index = buildIndex([
    { path: 'entry', type: 'symlink', target: 'x' },
    { path: 'x', type: 'symlink', target: 'y' },
    { path: 'y', type: 'symlink', target: 'z' },
    { path: 'z', type: 'symlink', target: 'y' },
  ]);
  assert.deepEqual(index.resolve('entry'), { ok: false, cycle: ['y', 'z'] });
  assert.deepEqual(index.resolve('x'), { ok: false, cycle: ['y', 'z'] });
  assert.deepEqual(index.resolve('z'), { ok: false, cycle: ['z', 'y'] });
});

test('cycle through normalized targets is detected', () => {
  const index = buildIndex([
    { path: 'a', type: 'symlink', target: 'dir/../b' },
    { path: 'b', type: 'symlink', target: './a' },
  ]);
  assert.deepEqual(index.resolve('a'), { ok: false, cycle: ['a', 'b'] });
});
