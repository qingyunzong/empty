import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePath } from "../src/path.ts";
import { containsPoint } from "../src/fill.ts";
import { findSelfIntersections } from "../src/selfintersect.ts";
import { onSegment } from "../src/geometry.ts";
import type { Point } from "../src/geometry.ts";

test("bowtie has one proper crossing at its center", () => {
  const [sub] = parsePath("M0 0 L4 4 L4 0 L0 4 Z");
  const hits = findSelfIntersections(sub.points);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.type, "proper");
  assert.equal(hits[0]!.edgeA, 0);
  assert.equal(hits[0]!.edgeB, 2);
  assert.deepEqual(hits[0]!.point, { x: 2, y: 2 });
});

test("simple convex ring reports no self-intersections", () => {
  const [sub] = parsePath("M0 0 L10 0 L10 10 L0 10 Z");
  assert.deepEqual(findSelfIntersections(sub.points), []);
});

test("non-adjacent edge touch is reported as touch, not proper", () => {
  // Spike out and back: edge 1-2 touches edge 3-4 at (2,0).
  const pts: Point[] = [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 2, y: 0 },
    { x: 2, y: 3 },
    { x: -2, y: 3 },
  ];
  const hits = findSelfIntersections(pts);
  assert.ok(hits.length >= 1);
  assert.ok(hits.every((h) => h.type === "touch"));
});

// Independent reference implementation: plain float ray casting with
// boundary check, written separately from the library code under test.
function referenceContains(
  rings: Point[][],
  p: Point,
  rule: "evenodd" | "nonzero",
): boolean {
  let crossings = 0;
  let winding = 0;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      if (onSegment(a, b, p)) return true;
      if (a.y <= p.y !== b.y <= p.y) {
        const xInt = a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y);
        if (xInt > p.x) {
          crossings++;
          winding += b.y > a.y ? 1 : -1;
        }
      }
    }
  }
  return rule === "evenodd" ? crossings % 2 === 1 : winding !== 0;
}

test("short paths: grid cross-check against edge-by-edge reference", () => {
  const paths = [
    "M0 0 L10 0 L10 10 L0 10 Z",
    "M0 0 L10 0 L0 10", // open: implicitly closed
    "M1 1 L8 2 L9 9 L2 8 Z",
    "M0 0 L20 0 L20 20 L0 20 Z M5 5 L5 15 L15 15 L15 5 Z",
    "M0 0 L20 0 L20 20 L0 20 Z M5 5 L15 5 L15 15 L5 15 Z",
    "M-5 -5 L5 -5 L5 5 L-5 5 Z M0 -8 L8 0 L0 8 L-8 0 Z",
  ];
  for (const d of paths) {
    const subs = parsePath(d);
    const rings = subs.map((s) => s.points);
    // Edge-by-edge self-intersection verification for every ring.
    for (const ring of rings) {
      assert.deepEqual(
        findSelfIntersections(ring),
        [],
        `expected simple ring in ${d}`,
      );
    }
    for (const rule of ["evenodd", "nonzero"] as const) {
      for (let x = -9; x <= 21; x++) {
        for (let y = -9; y <= 21; y++) {
          const got = containsPoint(subs, { x, y }, rule).inside;
          const want = referenceContains(rings, { x, y }, rule);
          assert.equal(
            got,
            want,
            `${rule} mismatch at (${x},${y}) for ${d}`,
          );
        }
      }
    }
  }
});

test("self-intersecting bowtie: both lobes filled, waist empty", () => {
  const subs = parsePath("M0 0 L4 4 L4 0 L0 4 Z");
  const [sub] = subs;
  assert.equal(findSelfIntersections(sub.points).length, 1);
  // Left lobe interior: wound +1, three crossings -> inside under both rules.
  assert.equal(containsPoint(subs, { x: 1, y: 2 }, "evenodd").inside, true);
  assert.equal(containsPoint(subs, { x: 1, y: 2 }, "nonzero").inside, true);
  // Right lobe interior: wound -1, one crossing -> inside under both rules.
  assert.equal(containsPoint(subs, { x: 3, y: 2 }, "nonzero").inside, true);
  assert.equal(containsPoint(subs, { x: 3, y: 2 }, "evenodd").inside, true);
  // Waist below the crossing: zero winding, even crossings -> outside.
  assert.equal(containsPoint(subs, { x: 2, y: 1 }, "evenodd").inside, false);
  assert.equal(containsPoint(subs, { x: 2, y: 1 }, "nonzero").inside, false);
});
