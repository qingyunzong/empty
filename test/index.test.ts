import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildIndex,
  DuplicatePathError,
  InvalidEntryError,
  PathEscapeError,
} from '../src/index';

test('index stores entries under normalized paths', () => {
  const index = buildIndex([
    { path: 'a//b/./c.txt', type: 'file' },
    { path: '/a', type: 'directory' },
  ]);
  assert.equal(index.size, 2);
  assert.deepEqual(index.get('a/b/c.txt'), {
    type: 'file',
    path: 'a/b/c.txt',
  });
  assert.deepEqual(index.get('a'), { type: 'directory', path: 'a' });
});

test('lookups normalize the query path', () => {
  const index = buildIndex([{ path: 'a/b.txt', type: 'file' }]);
  assert.ok(index.has('a//b.txt'));
  assert.ok(index.has('./a/./b.txt'));
  assert.ok(index.has('/a/b.txt/'));
  assert.ok(!index.has('a/B.txt'));
  assert.equal(index.get('a/c.txt'), undefined);
});

test('duplicate normalized paths reject the whole archive', () => {
  assert.throws(
    () =>
      buildIndex([
        { path: 'a/b', type: 'file' },
        { path: 'x/y', type: 'file' },
        { path: 'a//./b', type: 'file' },
      ]),
    (err: unknown) =>
      err instanceof DuplicatePathError && err.normalizedPath === 'a/b',
  );
});

test('dot-dot collisions are duplicates too', () => {
  assert.throws(
    () =>
      buildIndex([
        { path: 'dir/file', type: 'file' },
        { path: 'dir/sub/../file', type: 'file' },
      ]),
    DuplicatePathError,
  );
});

test('case-sensitive: differing case paths coexist', () => {
  const index = buildIndex([
    { path: 'Readme', type: 'file' },
    { path: 'readme', type: 'file' },
    { path: 'README', type: 'file' },
  ]);
  assert.equal(index.size, 3);
});

test('entry path escaping the root rejects the archive', () => {
  assert.throws(
    () => buildIndex([{ path: '../evil', type: 'file' }]),
    PathEscapeError,
  );
  assert.throws(
    () =>
      buildIndex([
        { path: 'ok', type: 'file' },
        { path: 'a/../../evil', type: 'file' },
      ]),
    PathEscapeError,
  );
});

test('symlink without a target is invalid', () => {
  assert.throws(
    () => buildIndex([{ path: 'link', type: 'symlink' }]),
    InvalidEntryError,
  );
});

test('symlink target escaping the root rejects the archive', () => {
  assert.throws(
    () => buildIndex([{ path: 'link', type: 'symlink', target: '../evil' }]),
    PathEscapeError,
  );
  assert.throws(
    () =>
      buildIndex([
        { path: 'dir/link', type: 'symlink', target: '../../evil' },
      ]),
    PathEscapeError,
  );
});
