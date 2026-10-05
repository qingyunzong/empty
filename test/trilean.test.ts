import { test } from 'node:test';
import { deepEqual, equal } from 'node:assert/strict';
import { F, T, U, triAnd, triNot, triOr, type Tri } from '../src/trilean.js';

const TRIS: Tri[] = [T, F, U];

test('not truth table (Kleene)', () => {
  equal(triNot(T), F);
  equal(triNot(F), T);
  equal(triNot(U), U);
});

test('and truth table (Kleene): F dominates, then U', () => {
  const expected: Record<Tri, Record<Tri, Tri>> = {
    T: { T: T, F: F, U: U },
    F: { T: F, F: F, U: F },
    U: { T: U, F: F, U: U },
  };
  for (const a of TRIS) {
    for (const b of TRIS) {
      equal(triAnd(a, b), expected[a][b], `and(${a},${b})`);
    }
  }
});

test('or truth table (Kleene): T dominates, then U', () => {
  const expected: Record<Tri, Record<Tri, Tri>> = {
    T: { T: T, F: T, U: T },
    F: { T: T, F: F, U: U },
    U: { T: T, F: U, U: U },
  };
  for (const a of TRIS) {
    for (const b of TRIS) {
      equal(triOr(a, b), expected[a][b], `or(${a},${b})`);
    }
  }
});

test('variadic and/or over empty and singleton args', () => {
  equal(triAnd(), T);
  equal(triOr(), F);
  equal(triAnd(U), U);
  equal(triOr(U), U);
  equal(triAnd(T, T, U, T), U);
  equal(triOr(F, U, F), U);
  deepEqual([triAnd(T, F, U), triOr(F, T, U)], [F, T]);
});
