import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePath } from "../src/path.ts";
import { containsPoint } from "../src/fill.ts";

const SQUARE = parsePath("M0 0 L10 0 L10 10 L0 10 Z"); // CCW in y-up coords

test("square: inside / outside under both rules", () => {
  for (const rule of ["evenodd", "nonzero"] as const) {
    assert.equal(containsPoint(SQUARE, { x: 5, y: 5 }, rule).inside, true);
    assert.equal(containsPoint(SQUARE, { x: 15, y: 5 }, rule).inside, false);
    assert.equal(containsPoint(SQUARE, { x: 5, y: -1 }, rule).inside, false);
  }
});

test("boundary counts as inside: edge midpoint and vertex", () => {
  for (const rule of ["evenodd", "nonzero"] as const) {
    const edge = containsPoint(SQUARE, { x: 5, y: 0 }, rule);
    assert.equal(edge.inside, true);
    assert.equal(edge.onBoundary, true);
    assert.equal(edge.rings[0]!.boundaryEdge, 0);
    const vertex = containsPoint(SQUARE, { x: 10, y: 10 }, rule);
    assert.equal(vertex.inside, true);
    assert.equal(vertex.onBoundary, true);
  }
});

test("open subpath is implicitly closed for filling", () => {
  const tri = parsePath("M0 0 L10 0 L0 10"); // no Z: closing edge (0,10)->(0,0)
  const r = containsPoint(tri, { x: 2, y: 2 }, "evenodd");
  assert.equal(r.inside, true);
  assert.equal(r.rings[0]!.implicitlyClosed, true);
  // Point beyond the implied closing edge (x < 0 side) is outside.
  assert.equal(containsPoint(tri, { x: -1, y: 5 }, "evenodd").inside, false);
});

test("nested rings same orientation: nonzero fills hole, evenodd cuts it", () => {
  const d =
    "M0 0 L20 0 L20 20 L0 20 Z " + // outer CCW
    "M5 5 L15 5 L15 15 L5 15 Z"; // inner CCW (same orientation)
  const subs = parsePath(d);
  const hole = { x: 10, y: 10 };
  assert.equal(containsPoint(subs, hole, "nonzero").inside, true);
  assert.equal(containsPoint(subs, hole, "nonzero").winding, 2);
  assert.equal(containsPoint(subs, hole, "evenodd").inside, false);
  // Hole boundary still counts as inside under both rules.
  assert.equal(containsPoint(subs, { x: 5, y: 10 }, "evenodd").inside, true);
  assert.equal(containsPoint(subs, { x: 5, y: 10 }, "nonzero").inside, true);
});

test("nested rings opposite orientation: hole is empty under both rules", () => {
  const d =
    "M0 0 L20 0 L20 20 L0 20 Z " + // outer CCW
    "M5 5 L5 15 L15 15 L15 5 Z"; // inner CW (reversed)
  const subs = parsePath(d);
  const hole = { x: 10, y: 10 };
  const nz = containsPoint(subs, hole, "nonzero");
  assert.equal(nz.inside, false);
  assert.equal(nz.winding, 0);
  assert.equal(containsPoint(subs, hole, "evenodd").inside, false);
  // Ring band between the two squares stays inside.
  assert.equal(containsPoint(subs, { x: 2, y: 10 }, "nonzero").inside, true);
});

test("direction evidence: orientation, winding sign and crossing directions", () => {
  const ccw = containsPoint(SQUARE, { x: 5, y: 5 }, "nonzero");
  const ring = ccw.rings[0]!;
  assert.equal(ring.orientation, "ccw");
  assert.equal(ring.winding, 1);
  assert.equal(ring.signedArea2, 200);
  assert.deepEqual(
    ring.crossings.map((c) => c.direction),
    ["up"],
  );
  assert.deepEqual(
    ring.crossings.map((c) => c.edgeIndex),
    [1],
  );

  const cwPath = parsePath("M0 0 L0 10 L10 10 L10 0 Z"); // reversed
  const cw = containsPoint(cwPath, { x: 5, y: 5 }, "nonzero");
  assert.equal(cw.rings[0]!.orientation, "cw");
  assert.equal(cw.rings[0]!.winding, -1);
  assert.deepEqual(
    cw.rings[0]!.crossings.map((c) => c.direction),
    ["down"],
  );
});

test("hit rings identify exactly which subpaths contain the point", () => {
  const subs = parsePath(
    "M0 0 L10 0 L10 10 L0 10 Z M20 0 L30 0 L30 10 L20 10 Z",
  );
  const r = containsPoint(subs, { x: 5, y: 5 }, "evenodd");
  assert.equal(r.inside, true);
  assert.deepEqual(r.hits.map((h) => h.ringIndex), [0]);
  const miss = containsPoint(subs, { x: 15, y: 5 }, "evenodd");
  assert.equal(miss.inside, false);
  assert.equal(miss.hits.length, 0);
});
