import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  orient,
  segmentRelation,
  pointInRing,
} from '../src/geometry.js';

test('orient is exact where float64 cancels to zero', () => {
  // (2^28+2)*(2^27-1) - (2^28)*(2^27) = 2^55 - 2 - 2^55 = -2 exactly,
  // but in float64 both products round to 2^55 and the difference is 0.
  const a = { x: 0, y: 0 };
  const b = { x: 2 ** 28 + 2, y: 2 ** 28 };
  const c = { x: 2 ** 27, y: 2 ** 27 - 1 };

  const naive =
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  assert.equal(naive, 0, 'float64 must actually lose the sign here');

  assert.equal(orient(a, b, c), -1, 'exact predicate keeps the true sign');
  assert.equal(orient(a, b, b), 0);
  assert.equal(orient(a, b, { x: 2 ** 27 + 1, y: 2 ** 27 }), 0);
});

test('segmentRelation classifies cross / touch / overlap / none', () => {
  assert.deepEqual(
    segmentRelation({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }),
    { kind: 'cross' },
  );
  // Endpoint of one segment in the interior of the other.
  assert.deepEqual(
    segmentRelation({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }),
    { kind: 'touch', point: { x: 5, y: 0 } },
  );
  // Shared endpoint only.
  assert.deepEqual(
    segmentRelation({ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }),
    { kind: 'touch', point: { x: 4, y: 0 } },
  );
  // Collinear overlap over a sub-segment.
  assert.deepEqual(
    segmentRelation({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 4, y: 0 }, { x: 20, y: 0 }),
    { kind: 'overlap' },
  );
  // Collinear but disjoint.
  assert.deepEqual(
    segmentRelation({ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 0 }, { x: 9, y: 0 }),
    { kind: 'none' },
  );
  // Parallel, separated.
  assert.deepEqual(
    segmentRelation({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 1 }, { x: 10, y: 1 }),
    { kind: 'none' },
  );
});

test('segmentRelation touch is exact at large coordinates', () => {
  // Midpoint of (0,0)-(2^28+2, 2^28) is exactly (2^27+1, 2^27).
  const mid = { x: 2 ** 27 + 1, y: 2 ** 27 };
  assert.deepEqual(
    segmentRelation(
      { x: 0, y: 0 },
      { x: 2 ** 28 + 2, y: 2 ** 28 },
      mid,
      { x: 2 ** 27 + 1, y: 2 ** 27 + 9 },
    ),
    { kind: 'touch', point: mid },
  );
  // Strictly below the line (the line passes at y = 2^27-1+epsilon at x=2^27,
  // a gap float64 cannot even represent): no relation at all.
  assert.deepEqual(
    segmentRelation(
      { x: 0, y: 0 },
      { x: 2 ** 28 + 2, y: 2 ** 28 },
      { x: 2 ** 27, y: 2 ** 27 - 9 },
      { x: 2 ** 27, y: 2 ** 27 - 1 },
    ),
    { kind: 'none' },
  );
});

test('pointInRing handles convex, concave and large coordinates', () => {
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  assert.equal(pointInRing({ x: 5, y: 5 }, square), true);
  assert.equal(pointInRing({ x: 15, y: 5 }, square), false);

  const concave = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 5, y: 3 },
    { x: 0, y: 10 },
  ];
  assert.equal(pointInRing({ x: 5, y: 8 }, concave), false); // in the notch
  assert.equal(pointInRing({ x: 2, y: 2 }, concave), true);

  const big = [
    { x: 0, y: 0 },
    { x: 1_000_000_000, y: 0 },
    { x: 1_000_000_000, y: 1_000_000_000 },
    { x: 0, y: 1_000_000_000 },
  ];
  assert.equal(pointInRing({ x: 1, y: 999_999_999 }, big), true);
  assert.equal(pointInRing({ x: -1, y: 5 }, big), false);
});
