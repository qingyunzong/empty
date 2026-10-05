import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePolygon, Polygon, Conflict } from '../src/polygon.js';

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

function conflictsOf(p: Polygon): readonly Conflict[] {
  const r = validatePolygon(p);
  assert.equal(r.ok, false, 'expected validation to fail');
  return (r as { ok: false; conflicts: readonly Conflict[] }).conflicts;
}

test('valid polygon with a hole passes', () => {
  assert.deepEqual(validatePolygon({ outer, holes: [hole] }), { ok: true });
});

test('valid hole-less polygon passes', () => {
  assert.deepEqual(validatePolygon({ outer, holes: [] }), { ok: true });
});

test('self-intersection reports the exact crossing edges', () => {
  const bowtie = {
    outer: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
      { x: 10, y: 10 },
    ],
    holes: [],
  };
  const conflicts = conflictsOf(bowtie);
  assert.equal(conflicts.length, 1);
  const c = conflicts[0]!;
  assert.equal(c.type, 'self-intersection');
  if (c.type === 'self-intersection') {
    assert.equal(c.edge1.ring, 0);
    assert.equal(c.edge1.edge, 1); // (10,0)-(0,10)
    assert.equal(c.edge2.edge, 3); // (10,10)-(0,0)
    assert.deepEqual(c.edge1.a, { x: 10, y: 0 });
    assert.deepEqual(c.edge2.b, { x: 0, y: 0 });
  }
});

test('self-touch reports the touching point and edges', () => {
  // v3 = (5,0) lands in the interior of edge 0 ((0,0)-(10,0)).
  const p = {
    outer: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 5, y: 0 },
      { x: 0, y: 10 },
    ],
    holes: [],
  };
  const touches = conflictsOf(p).filter((c) => c.type === 'self-touch');
  assert.equal(touches.length, 2); // edges 0&2 and 0&3
  for (const c of touches) {
    if (c.type === 'self-touch') {
      assert.deepEqual(c.point, { x: 5, y: 0 });
      assert.equal(c.edge1.edge, 0);
    }
  }
});

test('non-adjacent collinear overlap is a self-overlap conflict', () => {
  const p = {
    outer: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 6, y: 0 },
      { x: 2, y: 0 },
      { x: 0, y: 10 },
    ],
    holes: [],
  };
  const overlaps = conflictsOf(p).filter((c) => c.type === 'self-overlap');
  assert.equal(overlaps.length, 1);
  const c = overlaps[0]!;
  if (c.type === 'self-overlap') {
    assert.equal(c.edge1.edge, 0);
    assert.equal(c.edge2.edge, 3);
  }
});

test('adjacent fold-back overlap is rejected', () => {
  const p = {
    outer: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 0 },
      { x: 0, y: 10 },
    ],
    holes: [],
  };
  const types = conflictsOf(p).map((c) => c.type);
  assert.ok(types.includes('self-overlap'));
});

test('ring crossing between hole and outer reports both edges', () => {
  const escapedHole = [
    { x: 4, y: 4 },
    { x: 8, y: 4 },
    { x: 25, y: 25 },
    { x: 4, y: 8 },
  ];
  const crossings = conflictsOf({ outer, holes: [escapedHole] }).filter(
    (c) => c.type === 'ring-crossing',
  );
  assert.ok(crossings.length >= 1);
  for (const c of crossings) {
    if (c.type === 'ring-crossing') {
      assert.equal(c.edge1.ring, 0); // outer edge
      assert.equal(c.edge2.ring, 1); // hole edge
    }
  }
});

test('hole merely touching the outer ring is a conflict', () => {
  const touchingHole = [
    { x: 4, y: 4 },
    { x: 8, y: 4 },
    { x: 20, y: 8 }, // exactly on outer edge (20,0)-(20,20)
    { x: 4, y: 8 },
  ];
  const touches = conflictsOf({ outer, holes: [touchingHole] }).filter(
    (c) => c.type === 'ring-touch',
  );
  assert.ok(touches.length >= 1);
  const c = touches[0]!;
  if (c.type === 'ring-touch') assert.deepEqual(c.point, { x: 20, y: 8 });
});

test('hole fully outside the outer ring is caught by containment', () => {
  const outsideHole = hole.map((v) => ({ x: v.x + 30, y: v.y }));
  const conflicts = conflictsOf({ outer, holes: [outsideHole] });
  assert.deepEqual(
    conflicts.filter((c) => c.type === 'hole-outside-outer'),
    [{ type: 'hole-outside-outer', ring: 1, vertex: { x: 34, y: 4 } }],
  );
});

test('hole nested inside another hole is a conflict', () => {
  const big = [
    { x: 2, y: 2 },
    { x: 12, y: 2 },
    { x: 12, y: 12 },
    { x: 2, y: 12 },
  ];
  const small = [
    { x: 4, y: 4 },
    { x: 6, y: 4 },
    { x: 6, y: 6 },
    { x: 4, y: 6 },
  ];
  const conflicts = conflictsOf({ outer, holes: [big, small] });
  assert.deepEqual(
    conflicts.filter((c) => c.type === 'hole-inside-hole'),
    [{ type: 'hole-inside-hole', ring: 2, otherRing: 1, vertex: { x: 4, y: 4 } }],
  );
});

test('degenerate rings are rejected with reasons', () => {
  const zeroLength = conflictsOf({
    outer: [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ],
    holes: [],
  });
  assert.ok(zeroLength.some((c) => c.type === 'degenerate-ring'));

  const tooShort = conflictsOf({
    outer: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ],
    holes: [],
  });
  assert.ok(tooShort.some((c) => c.type === 'degenerate-ring'));

  const nonInteger = conflictsOf({
    outer: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5.5, y: 10 },
    ],
    holes: [],
  });
  assert.ok(nonInteger.some((c) => c.type === 'degenerate-ring'));
});
