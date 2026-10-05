import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PolygonStore } from '../src/store.js';
import { Polygon } from '../src/polygon.js';

const outer = [
  { x: 0, y: 0 },
  { x: 20, y: 0 },
  { x: 20, y: 20 },
  { x: 0, y: 20 },
];
const hole = [
  { x: 4, y: 4 },
  { x: 8, y: 4 },
  { x: 8, y: 8 },
  { x: 4, y: 8 },
];
const base: Polygon = { outer, holes: [hole] };

test('create publishes version 1 and rejects invalid input', () => {
  const store = new PolygonStore();
  assert.deepEqual(store.create('p', base), { ok: true, version: 1 });
  assert.equal(store.latestVersion('p'), 1);

  const bad = store.create('q', {
    outer: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
      { x: 10, y: 10 },
    ],
    holes: [],
  });
  assert.equal(bad.ok, false);
  assert.equal(store.latestVersion('q'), 0);
  assert.equal(store.get('q'), undefined);
});

test('batch move publishes a new version; old versions stay readable', () => {
  const store = new PolygonStore();
  store.create('p', base);

  const moved = store.moveVertices('p', [
    { ring: 0, index: 1, to: { x: 24, y: 0 } },
    { ring: 1, index: 0, to: { x: 3, y: 3 } },
  ]);
  assert.deepEqual(moved, { ok: true, version: 2 });
  assert.equal(store.latestVersion('p'), 2);

  const v1 = store.get('p', 1)!;
  const v2 = store.get('p', 2)!;
  assert.deepEqual(v1.outer[1], { x: 20, y: 0 }); // old version untouched
  assert.deepEqual(v2.outer[1], { x: 24, y: 0 });
  assert.deepEqual(v2.holes[0]![0], { x: 3, y: 3 });
  assert.deepEqual(store.get('p'), v2); // default is latest
});

test('rejected batch is atomic: nothing is published', () => {
  const store = new PolygonStore();
  store.create('p', base);

  // First move is fine; second turns the outer ring into a bowtie.
  const result = store.moveVertices('p', [
    { ring: 0, index: 1, to: { x: 24, y: 0 } },
    { ring: 0, index: 2, to: { x: 0, y: -5 } },
  ]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.conflicts.length > 0);
    assert.ok(
      result.conflicts.every((c) => 'edge1' in c || c.type.startsWith('hole')),
    );
  }
  assert.equal(store.latestVersion('p'), 1, 'no partial publish');
  assert.deepEqual(store.get('p'), base, 'latest version unchanged');
});

test('move making the ring self-intersect gives edge evidence', () => {
  const store = new PolygonStore();
  store.create('p', {
    outer: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ],
    holes: [],
  });
  // Swap-ish move: vertex 2 jumps across the diagonal -> bowtie.
  const r = store.moveVertices('p', [{ ring: 0, index: 2, to: { x: 0, y: 0 } }]);
  assert.equal(r.ok, false);
  if (!r.ok) {
    const self = r.conflicts.filter((c) => c.type.startsWith('self'));
    assert.ok(self.length > 0);
    const c = self[0]!;
    if ('edge1' in c) {
      assert.equal(c.edge1.ring, 0);
      assert.ok(Number.isInteger(c.edge1.edge));
    }
  }
});

test('move pushing the hole outside the outer ring is rejected', () => {
  const store = new PolygonStore();
  store.create('p', base);
  const r = store.moveVertices('p', [
    { ring: 1, index: 0, to: { x: 34, y: 4 } },
    { ring: 1, index: 1, to: { x: 38, y: 4 } },
    { ring: 1, index: 2, to: { x: 38, y: 8 } },
    { ring: 1, index: 3, to: { x: 34, y: 8 } },
  ]);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.deepEqual(
      r.conflicts.filter((c) => c.type === 'hole-outside-outer'),
      [{ type: 'hole-outside-outer', ring: 1, vertex: { x: 34, y: 4 } }],
    );
  }
  assert.equal(store.latestVersion('p'), 1);
});

test('move making the hole touch the outer ring is rejected (touch = conflict)', () => {
  const store = new PolygonStore();
  store.create('p', base);
  const r = store.moveVertices('p', [{ ring: 1, index: 2, to: { x: 20, y: 8 } }]);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(r.conflicts.some((c) => c.type === 'ring-touch'));
  }
});

test('exactness: razor-thin valid triangle is accepted, exact collapse rejected', () => {
  const store = new PolygonStore();
  // Area is exactly 1 (orient = -2); float64 orientation would say degenerate.
  const thin = {
    outer: [
      { x: 0, y: 0 },
      { x: 2 ** 28 + 2, y: 2 ** 28 },
      { x: 2 ** 27, y: 2 ** 27 - 1 },
    ],
    holes: [],
  };
  assert.deepEqual(store.create('thin', thin), { ok: true, version: 1 });

  // Moving vertex 2 onto the exact midpoint of edge 0 collapses the triangle.
  const r = store.moveVertices('thin', [
    { ring: 0, index: 2, to: { x: 2 ** 27 + 1, y: 2 ** 27 } },
  ]);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(r.conflicts.some((c) => c.type === 'self-overlap'));
  }
  assert.equal(store.latestVersion('thin'), 1);
});

test('invalid move targets and non-integer targets are rejected', () => {
  const store = new PolygonStore();
  store.create('p', base);
  for (const moves of [
    [{ ring: 5, index: 0, to: { x: 1, y: 1 } }],
    [{ ring: 0, index: 99, to: { x: 1, y: 1 } }],
    [{ ring: 0, index: 0, to: { x: 1.5, y: 1 } }],
  ]) {
    const r = store.moveVertices('p', moves);
    assert.equal(r.ok, false);
  }
  assert.equal(store.latestVersion('p'), 1);
});

test('returned polygons are deep copies; history cannot be mutated', () => {
  const store = new PolygonStore();
  store.create('p', base);
  const snapshot = store.get('p')!;
  (snapshot.outer as { x: number; y: number }[])[0]!.x = -999;
  assert.deepEqual(store.get('p')!.outer[0], { x: 0, y: 0 });
});
