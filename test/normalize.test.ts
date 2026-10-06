import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { normalizePath, PathEscapeError } from '../src/index';
import { slowNormalize } from '../src/slow';

const normalizers = [
  ['fast', normalizePath],
  ['slow', slowNormalize],
] as const;

for (const [name, normalize] of normalizers) {
  test(`${name}: plain paths pass through`, () => {
    assert.equal(normalize('a/b/c'), 'a/b/c');
    assert.equal(normalize('file.txt'), 'file.txt');
  });

  test(`${name}: empty and dot segments are eliminated`, () => {
    assert.equal(normalize('a/./b/./c'), 'a/b/c');
    assert.equal(normalize('a//b///c'), 'a/b/c');
    assert.equal(normalize('/a/b/'), 'a/b');
    assert.equal(normalize('./a'), 'a');
    assert.equal(normalize('a/.'), 'a');
    assert.equal(normalize('////'), '');
    assert.equal(normalize(''), '');
  });

  test(`${name}: dot-dot pops the previous segment`, () => {
    assert.equal(normalize('a/b/../c'), 'a/c');
    assert.equal(normalize('a/b/..'), 'a');
    assert.equal(normalize('a/b/../..'), '');
  });

  test(`${name}: escaping the root is rejected`, () => {
    assert.throws(() => normalize('..'), PathEscapeError);
    assert.throws(() => normalize('../a'), PathEscapeError);
    assert.throws(() => normalize('a/../..'), PathEscapeError);
    assert.throws(() => normalize('a/../../b'), PathEscapeError);
    assert.throws(() => normalize('a/b/../../../c'), PathEscapeError);
  });

  test(`${name}: matching is case-sensitive`, () => {
    assert.equal(normalize('A/./B'), 'A/B');
    assert.equal(normalize('a/../A'), 'A');
    assert.ok(normalize('Readme') !== normalize('readme'));
  });
}
