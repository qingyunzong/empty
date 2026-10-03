import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalize, union, intersect, difference, contains, gaps, overlapReport,
} from '../src/intervals.js';
import { AuditError } from '../src/errors.js';

// Deterministic PRNG so failures are reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// O(n^2) reference: membership decided by scanning every raw interval.
function refMember(raw, p) {
  return raw.some(([s, e]) => s <= p && p < e);
}

function refOp(a, b, op, p) {
  if (op === 'union') return refMember(a, p) || refMember(b, p);
  if (op === 'intersect') return refMember(a, p) && refMember(b, p);
  return refMember(a, p) && !refMember(b, p);
}

test('acceptance 1: adjacent boundaries [0,5) and [5,9) do not overlap', () => {
  assert.deepEqual(overlapReport([[0, 5], [5, 9]]), []);
  assert.deepEqual(intersect([[0, 5]], [[5, 9]]), []);
  assert.equal(contains([[0, 5]], 5), false);
  assert.equal(contains([[5, 9]], 5), true);
  // but their union is contiguous, so normalization merges them
  assert.deepEqual(normalize([[5, 9], [0, 5]]), [[0, 9]]);
});

test('normalize sorts and merges overlapping/touching intervals', () => {
  assert.deepEqual(
    normalize([[10, 12], [0, 3], [2, 5], [5, 7]]),
    [[0, 7], [10, 12]],
  );
  assert.deepEqual(normalize([]), []);
});

test('set algebra basics', () => {
  assert.deepEqual(union([[0, 4]], [[3, 6]]), [[0, 6]]);
  assert.deepEqual(intersect([[0, 4], [10, 12]], [[3, 11]]), [[3, 4], [10, 11]]);
  assert.deepEqual(difference([[0, 10]], [[2, 4], [6, 8]]), [[0, 2], [4, 6], [8, 10]]);
  assert.deepEqual(difference([[0, 3]], [[5, 9]]), [[0, 3]]);
});

test('gaps reports holes inside a bound', () => {
  assert.deepEqual(gaps([[0, 5], [9, 20]], [0, 20]), [[5, 9]]);
  assert.deepEqual(gaps([[2, 8]], [0, 10]), [[0, 2], [8, 10]]);
  assert.deepEqual(gaps([[0, 10]], [0, 10]), []);
});

test('overlapReport finds genuine overlaps only', () => {
  const raw = [[0, 6], [5, 9], [20, 21]];
  assert.deepEqual(overlapReport(raw), [{ a: 0, b: 1, intersection: [5, 6] }]);
});

test('invalid intervals raise E_INTERVAL', () => {
  for (const bad of [[5, 5], [9, 5], [0], [0, Number.NaN], ['a', 2], 7]) {
    assert.throws(() => normalize([bad]), (err) => {
      assert.ok(err instanceof AuditError);
      assert.equal(err.code, 'E_INTERVAL');
      return true;
    });
  }
  assert.throws(() => contains([[0, 1]], Number.NaN), { code: 'E_INTERVAL' });
});

test('acceptance 4: random small intervals match O(n^2) reference', () => {
  const rand = mulberry32(20261004);
  const samples = [];
  for (let x = -2; x <= 44; x += 1) samples.push(x / 2); // quarter-resolution grid
  for (let round = 0; round < 300; round += 1) {
    const make = () => {
      const n = 1 + Math.floor(rand() * 6);
      const raw = [];
      for (let k = 0; k < n; k += 1) {
        const s = Math.floor(rand() * 20);
        const e = s + 1 + Math.floor(rand() * 8);
        raw.push([s, e]);
      }
      return raw;
    };
    const a = make();
    const b = make();
    const results = {
      union: union(a, b),
      intersect: intersect(a, b),
      difference: difference(a, b),
    };
    for (const [op, set] of Object.entries(results)) {
      // result must be normalized
      assert.deepEqual(set, normalize(set), `${op} result not normalized`);
      for (const p of samples) {
        assert.equal(
          contains(set, p),
          refOp(a, b, op, p),
          `${op} mismatch at p=${p} a=${JSON.stringify(a)} b=${JSON.stringify(b)}`,
        );
      }
    }
  }
});
