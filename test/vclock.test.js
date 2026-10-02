'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vclock = require('../lib/vclock');

// Enumerate all vector clocks of a given dimension with components in [0, max].
function enumerateVectors(dim, max) {
  const out = [];
  const current = new Array(dim).fill(0);
  (function rec(i) {
    if (i === dim) {
      out.push([...current]);
      return;
    }
    for (let v = 0; v <= max; v++) {
      current[i] = v;
      rec(i + 1);
    }
  })(0);
  return out;
}

function toClock(vec) {
  const clock = {};
  vec.forEach((v, i) => {
    if (v !== 0) clock[`n${i}`] = v;
  });
  return clock;
}

// Independent reference implementation of the partial order, written
// separately from lib/vclock.js so the tests verify rather than restate it.
function leqReference(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] > b[i]) return false;
  }
  return true;
}

function compareReference(a, b) {
  const ab = leqReference(a, b);
  const ba = leqReference(b, a);
  if (ab && ba) return vclock.EQUAL;
  if (ab) return vclock.LESS;
  if (ba) return vclock.GREATER;
  return vclock.CONCURRENT;
}

test('compare matches independent partial-order definition for all clock pairs (dim <= 3)', () => {
  for (let dim = 1; dim <= 3; dim++) {
    const vectors = enumerateVectors(dim, 2);
    for (const u of vectors) {
      for (const v of vectors) {
        assert.equal(
          vclock.compare(toClock(u), toClock(v)),
          compareReference(u, v),
          `dim=${dim} u=${u} v=${v}`,
        );
      }
    }
  }
});

test('partial-order axioms hold over enumerated small clocks (dim <= 3)', () => {
  for (let dim = 1; dim <= 3; dim++) {
    const vectors = enumerateVectors(dim, 2);
    for (const u of vectors) {
      // reflexivity
      assert.equal(vclock.compare(toClock(u), toClock(u)), vclock.EQUAL);
      for (const v of vectors) {
        const uv = vclock.compare(toClock(u), toClock(v));
        const vu = vclock.compare(toClock(v), toClock(u));
        // antisymmetry
        if (uv === vclock.EQUAL) assert.equal(vu, vclock.EQUAL);
        // asymmetry of strict order
        if (uv === vclock.LESS) assert.equal(vu, vclock.GREATER);
        if (uv === vclock.GREATER) assert.equal(vu, vclock.LESS);
        // concurrency is symmetric
        if (uv === vclock.CONCURRENT) assert.equal(vu, vclock.CONCURRENT);
        for (const w of vectors) {
          // transitivity of <=
          if (leqReference(u, v) && leqReference(v, w)) {
            assert.ok(
              leqReference(u, w),
              `transitivity violated: ${u} <= ${v} <= ${w} but not ${u} <= ${w}`,
            );
            const uw = vclock.compare(toClock(u), toClock(w));
            assert.ok(uw === vclock.LESS || uw === vclock.EQUAL);
          }
        }
      }
    }
  }
});

test('happensBefore / areConcurrent agree with compare', () => {
  const vectors = enumerateVectors(3, 2);
  for (const u of vectors) {
    for (const v of vectors) {
      const cmp = vclock.compare(toClock(u), toClock(v));
      assert.equal(vclock.happensBefore(toClock(u), toClock(v)), cmp === vclock.LESS);
      assert.equal(vclock.areConcurrent(toClock(u), toClock(v)), cmp === vclock.CONCURRENT);
    }
  }
});

test('mergeClocks is component-wise max and dominates both operands', () => {
  const vectors = enumerateVectors(3, 2);
  for (const u of vectors) {
    for (const v of vectors) {
      const merged = vclock.mergeClocks(toClock(u), toClock(v));
      for (let i = 0; i < 3; i++) {
        assert.equal(merged[`n${i}`] || 0, Math.max(u[i], v[i]));
      }
      const cu = vclock.compare(merged, toClock(u));
      const cv = vclock.compare(merged, toClock(v));
      assert.ok(cu === vclock.GREATER || cu === vclock.EQUAL);
      assert.ok(cv === vclock.GREATER || cv === vclock.EQUAL);
    }
  }
});

test('isRegression detects any component decrease', () => {
  assert.equal(vclock.isRegression({ a: 2 }, { a: 1, b: 5 }), true);
  assert.equal(vclock.isRegression({ a: 2 }, { a: 2 }), false);
  assert.equal(vclock.isRegression({ a: 2 }, { a: 3, b: 1 }), false);
  assert.equal(vclock.isRegression({}, {}), false);
});
