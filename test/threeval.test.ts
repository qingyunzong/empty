import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tri, type Tri } from '../src/threeval.js';

const VALUES: Tri[] = ['T', 'F', 'U'];

test('and truth table', () => {
  const expected: Record<string, Tri> = {
    TT: 'T', TF: 'F', TU: 'U',
    FT: 'F', FF: 'F', FU: 'F',
    UT: 'U', UF: 'F', UU: 'U',
  };
  for (const a of VALUES) {
    for (const b of VALUES) {
      assert.equal(tri.and(a, b), expected[`${a}${b}`], `and(${a},${b})`);
    }
  }
});

test('or truth table', () => {
  const expected: Record<string, Tri> = {
    TT: 'T', TF: 'T', TU: 'T',
    FT: 'T', FF: 'F', FU: 'U',
    UT: 'T', UF: 'U', UU: 'U',
  };
  for (const a of VALUES) {
    for (const b of VALUES) {
      assert.equal(tri.or(a, b), expected[`${a}${b}`], `or(${a},${b})`);
    }
  }
});

test('not truth table', () => {
  assert.equal(tri.not('T'), 'F');
  assert.equal(tri.not('F'), 'T');
  assert.equal(tri.not('U'), 'U');
});

test('fromBool', () => {
  assert.equal(tri.fromBool(true), 'T');
  assert.equal(tri.fromBool(false), 'F');
});
