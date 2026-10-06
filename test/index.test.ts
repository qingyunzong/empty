import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, isArchiveError } from '../src/index.js';
import type { ArchiveEntry } from '../src/index.js';

const file = (path: string): ArchiveEntry => ({ path, type: 'file' });
const dir = (path: string): ArchiveEntry => ({ path, type: 'dir' });
const link = (path: string, target: string): ArchiveEntry => ({ path, type: 'symlink', target });

test('duplicate normalized paths reject the whole package', () => {
  for (const entries of [
    [file('a/b'), file('a//./b')],
    [file('x'), file('./x')],
    [dir('d'), dir('d/')],
    [file('a/../b'), file('b')],
    [link('l', 'a'), link('l', 'b')],
  ]) {
    assert.throws(() => buildIndex(entries), (err) => isArchiveError(err, 'DUPLICATE_PATH'));
  }
});

test('paths differing only by case are distinct entries', () => {
  const index = buildIndex([file('A/readme'), file('a/README')]);
  assert.equal(index.size, 2);
  assert.equal(index.resolve('A/readme').type, 'file');
  assert.equal(index.resolve('a/README').type, 'file');
});

test('root-escaping entry paths reject the package', () => {
  assert.throws(() => buildIndex([file('../evil')]), (err) => isArchiveError(err, 'ESCAPE_ROOT'));
  assert.throws(() => buildIndex([file('a/../../evil')]), (err) => isArchiveError(err, 'ESCAPE_ROOT'));
});

test('entries that normalize to the root are rejected', () => {
  for (const p of ['', '/', '.', 'a/..']) {
    assert.throws(() => buildIndex([file(p)]), (err) => isArchiveError(err, 'EMPTY_PATH'), p);
  }
});

test('non-directory parents conflict, in either insertion order', () => {
  assert.throws(() => buildIndex([file('a'), file('a/b')]), (err) => isArchiveError(err, 'TYPE_CONFLICT'));
  assert.throws(() => buildIndex([file('a/b'), file('a')]), (err) => isArchiveError(err, 'TYPE_CONFLICT'));
  assert.throws(() => buildIndex([link('a', 'x'), file('a/b')]), (err) => isArchiveError(err, 'TYPE_CONFLICT'));
});

test('explicit dir may fill in an implicit parent', () => {
  const index = buildIndex([file('a/b/c'), dir('a')]);
  assert.equal(index.resolve('a').type, 'dir');
  assert.equal(index.resolve('a/b').type, 'dir');
  assert.equal(index.resolve('a/b').entry, null);
});

test('symlinks expand by their normalized target', () => {
  const index = buildIndex([
    file('dir/real.txt'),
    link('link', 'dir'),
    link('doc', 'dir/./real.txt'),
    link('abs', '/dir/real.txt'),
  ]);
  assert.deepEqual(index.resolve('link/real.txt').path, 'dir/real.txt');
  assert.deepEqual(index.resolve('doc').path, 'dir/real.txt');
  assert.deepEqual(index.resolve('abs').path, 'dir/real.txt');
  assert.equal(index.resolve('doc').type, 'file');
});

test('relative symlink targets resolve against the parent directory', () => {
  const index = buildIndex([
    file('a/sibling.txt'),
    link('a/b/link', '../sibling.txt'),
    link('a/b/deep', '../../a/sibling.txt'),
  ]);
  assert.equal(index.resolve('a/b/link').path, 'a/sibling.txt');
  assert.equal(index.resolve('a/b/deep').path, 'a/sibling.txt');
});

test('symlink targets escaping the root reject the package', () => {
  assert.throws(
    () => buildIndex([link('x', '../../etc/passwd')]),
    (err) => isArchiveError(err, 'ESCAPE_ROOT'),
  );
  assert.throws(
    () => buildIndex([link('a/x', '../../../etc')]),
    (err) => isArchiveError(err, 'ESCAPE_ROOT'),
  );
});

test('symlink without a target rejects the package', () => {
  assert.throws(
    () => buildIndex([{ path: 'x', type: 'symlink' }]),
    (err) => isArchiveError(err, 'MISSING_TARGET'),
  );
});

test('chained symlinks resolve transitively', () => {
  const index = buildIndex([file('real/data'), link('one', 'two'), link('two', 'real')]);
  assert.equal(index.resolve('one/data').path, 'real/data');
});

test('symlink cycles report the shortest repeated chain', () => {
  const two = buildIndex([link('a', 'b'), link('b', 'a')]);
  assert.throws(
    () => two.resolve('a'),
    (err) => isArchiveError(err, 'SYMLINK_CYCLE') && err.chain!.join(',') === 'a,b',
  );

  const self = buildIndex([link('s', 's')]);
  assert.throws(
    () => self.resolve('s'),
    (err) => isArchiveError(err, 'SYMLINK_CYCLE') && err.chain!.join(',') === 's',
  );

  // a -> b -> c -> b: the repeated chain is [b, c], the entry prefix a is not part of it.
  const rho = buildIndex([link('a', 'b'), link('b', 'c'), link('c', 'b')]);
  assert.throws(
    () => rho.resolve('a'),
    (err) => isArchiveError(err, 'SYMLINK_CYCLE') && err.chain!.join(',') === 'b,c',
  );
});

test('cycles are detected through deeper paths and mid-path symlinks', () => {
  const index = buildIndex([link('a', 'b'), link('b', 'a'), file('z')]);
  assert.throws(() => index.resolve('a/deep/path'), (err) => isArchiveError(err, 'SYMLINK_CYCLE'));
  assert.equal(index.resolve('z').path, 'z');
});

test('lookup paths are normalized before resolution', () => {
  const index = buildIndex([file('a/b.txt'), link('lnk', 'a')]);
  assert.equal(index.resolve('x/../a/b.txt').path, 'a/b.txt');
  assert.equal(index.resolve('./lnk//b.txt').path, 'a/b.txt');
  assert.throws(() => index.resolve('../escape'), (err) => isArchiveError(err, 'ESCAPE_ROOT'));
});

test('missing targets report NOT_FOUND', () => {
  const index = buildIndex([file('a/b')]);
  assert.throws(() => index.resolve('a/c'), (err) => isArchiveError(err, 'NOT_FOUND'));
  assert.throws(() => index.resolve('nope'), (err) => isArchiveError(err, 'NOT_FOUND'));
});

test('root resolves to a directory', () => {
  const index = buildIndex([file('a')]);
  assert.equal(index.resolve('').type, 'dir');
  assert.equal(index.resolve('/').path, '');
});
