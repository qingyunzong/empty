import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePath, PathParseError } from '../src/index.js';

test('parses absolute move/line/close', () => {
  const subpaths = parsePath('M0 0 L10 0 L10 10 Z');
  assert.equal(subpaths.length, 1);
  assert.deepEqual(subpaths[0]!.points, [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ]);
  assert.equal(subpaths[0]!.closed, true);
});

test('implicit line-to pairs after moveto', () => {
  const subpaths = parsePath('M 1 2 3 4 5 6');
  assert.equal(subpaths.length, 1);
  assert.deepEqual(subpaths[0]!.points, [
    { x: 1, y: 2 },
    { x: 3, y: 4 },
    { x: 5, y: 6 },
  ]);
  assert.equal(subpaths[0]!.closed, false);
});

test('relative commands accumulate from current point', () => {
  const subpaths = parsePath('m10 10 l5 0 l0 5 z');
  assert.deepEqual(subpaths[0]!.points, [
    { x: 10, y: 10 },
    { x: 15, y: 10 },
    { x: 15, y: 15 },
  ]);
  assert.equal(subpaths[0]!.closed, true);
});

test('multiple subpaths via repeated moveto', () => {
  const subpaths = parsePath('M0 0 L4 0 L4 4 Z M10 10 L12 10');
  assert.equal(subpaths.length, 2);
  assert.equal(subpaths[0]!.closed, true);
  assert.equal(subpaths[1]!.closed, false);
  assert.deepEqual(subpaths[1]!.points, [
    { x: 10, y: 10 },
    { x: 12, y: 10 },
  ]);
});

test('commas, signs, decimals and exponents in numbers', () => {
  const subpaths = parsePath('M-1.5,2e1 L+3 .5');
  assert.deepEqual(subpaths[0]!.points, [
    { x: -1.5, y: 20 },
    { x: 3, y: 0.5 },
  ]);
});

test('rejects unsupported commands and malformed data', () => {
  assert.throws(() => parsePath('M0 0 H5'), PathParseError);
  assert.throws(() => parsePath('M0 0 C1 1 2 2 3 3'), PathParseError);
  assert.throws(() => parsePath('L1 1'), PathParseError);
  assert.throws(() => parsePath('M0 0 Z Z'), PathParseError);
  assert.throws(() => parsePath('M0'), PathParseError);
  assert.throws(() => parsePath('M0 0 L'), PathParseError);
});

test('empty path data yields no subpaths', () => {
  assert.deepEqual(parsePath(''), []);
});
