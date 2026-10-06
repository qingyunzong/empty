import assert from 'node:assert/strict';
import test from 'node:test';
import { hitTestPath } from '../src/index.js';

const SQUARE = 'M0 0 L10 0 L10 10 L0 10 Z';

test('nonzero rule: interior, exterior and boundary of a square', () => {
  assert.equal(hitTestPath(SQUARE, 5, 5, { rule: 'nonzero' }).inside, true);
  assert.equal(hitTestPath(SQUARE, 15, 5, { rule: 'nonzero' }).inside, false);
  assert.equal(hitTestPath(SQUARE, -1, -1, { rule: 'nonzero' }).inside, false);
});

test('boundary counts as inside: edges and corners', () => {
  for (const rule of ['evenodd', 'nonzero'] as const) {
    for (const [x, y] of [[5, 0], [0, 5], [10, 5], [5, 10], [0, 0], [10, 10]] as const) {
      const result = hitTestPath(SQUARE, x, y, { rule });
      assert.equal(result.inside, true, `${rule} at (${x},${y})`);
      assert.equal(result.onBoundary, true);
    }
  }
});

test('evenodd and nonzero agree on a simple convex ring', () => {
  for (const [x, y, expected] of [[5, 5, true], [20, 20, false]] as const) {
    assert.equal(hitTestPath(SQUARE, x, y, { rule: 'evenodd' }).inside, expected);
    assert.equal(hitTestPath(SQUARE, x, y, { rule: 'nonzero' }).inside, expected);
  }
});

const DONUT_SAME = 'M0 0 L20 0 L20 20 L0 20 Z M5 5 L15 5 L15 15 L5 15 Z';
const DONUT_OPPOSITE = 'M0 0 L20 0 L20 20 L0 20 Z M5 5 L5 15 L15 15 L15 5 Z';

test('nested same-direction rings: rules disagree inside the hole', () => {
  // Both rings CCW -> winding 2 in the hole.
  assert.equal(hitTestPath(DONUT_SAME, 10, 10, { rule: 'nonzero' }).inside, true);
  assert.equal(hitTestPath(DONUT_SAME, 10, 10, { rule: 'evenodd' }).inside, false);
  // Between the rings both rules agree.
  assert.equal(hitTestPath(DONUT_SAME, 2, 2, { rule: 'nonzero' }).inside, true);
  assert.equal(hitTestPath(DONUT_SAME, 2, 2, { rule: 'evenodd' }).inside, true);
});

test('nested opposite-direction rings: hole excluded under both rules', () => {
  assert.equal(hitTestPath(DONUT_OPPOSITE, 10, 10, { rule: 'nonzero' }).inside, false);
  assert.equal(hitTestPath(DONUT_OPPOSITE, 10, 10, { rule: 'evenodd' }).inside, false);
  assert.equal(hitTestPath(DONUT_OPPOSITE, 2, 2, { rule: 'nonzero' }).inside, true);
});

test('open subpath is implicitly closed when filled', () => {
  const openTriangle = 'M0 0 L10 0 L0 10';
  const result = hitTestPath(openTriangle, 2, 2, { rule: 'nonzero' });
  assert.equal(result.inside, true);
  assert.equal(result.rings[0]!.closed, false);
  assert.equal(result.rings[0]!.implicitlyClosed, true);
  assert.equal(hitTestPath(openTriangle, 8, 8, { rule: 'nonzero' }).inside, false);
});

test('hit rings and direction evidence are reported', () => {
  const result = hitTestPath(DONUT_SAME, 10, 10, { rule: 'nonzero' });
  assert.deepEqual(result.hits, [0, 1]);
  assert.equal(result.rings[0]!.direction, 'ccw');
  assert.equal(result.rings[0]!.signedArea2, 800);
  assert.equal(result.rings[0]!.winding, 1);
  assert.equal(result.rings[1]!.winding, 1);

  const reversed = hitTestPath(DONUT_OPPOSITE, 10, 10, { rule: 'nonzero' });
  assert.equal(reversed.rings[1]!.direction, 'cw');
  assert.equal(reversed.rings[1]!.winding, -1);
  // Both rings individually cover the point; opposite windings cancel out.
  assert.deepEqual(reversed.hits, [0, 1]);

  const odd = hitTestPath(DONUT_SAME, 10, 10, { rule: 'evenodd' });
  assert.deepEqual(odd.hits, [0, 1]);
});

test('integer query points use exact arithmetic at large coordinates', () => {
  const big = 'M0 0 L1073741824 0 L1073741824 1073741824 L0 1073741824 Z';
  assert.equal(hitTestPath(big, 1073741823, 1073741823, { rule: 'nonzero' }).inside, true);
  assert.equal(hitTestPath(big, 1073741825, 0, { rule: 'nonzero' }).inside, false);
  assert.equal(hitTestPath(big, 536870912, 0, { rule: 'evenodd' }).onBoundary, true);
});

test('degenerate subpaths contribute no interior', () => {
  assert.equal(hitTestPath('M5 5', 5, 5, { rule: 'nonzero' }).inside, false);
  assert.equal(hitTestPath('M0 0 L10 0', 5, 0, { rule: 'nonzero' }).onBoundary, true);
  assert.equal(hitTestPath('M0 0 L10 0', 5, 0, { rule: 'nonzero' }).inside, true);
  assert.equal(hitTestPath('M0 0 L10 0', 5, 1, { rule: 'nonzero' }).inside, false);
});
