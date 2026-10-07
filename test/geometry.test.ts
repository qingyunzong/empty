import test from "node:test";
import assert from "node:assert";
import {
  onSegment,
  orient,
  pointInRing,
  segmentIntersection,
  signedArea2,
} from "../src/geometry";

test("orient: sign of turn, exact for huge coordinates", () => {
  assert.equal(orient({ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }), 12n);
  assert.equal(orient({ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: -3 }), -12n);
  assert.equal(orient({ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 8, y: 0 }), 0n);
  // Near 2^53 float64 cannot represent every integer; BigInt stays exact.
  const big = Number.MAX_SAFE_INTEGER; // 2^53 - 1
  assert.equal(orient({ x: 0, y: 0 }, { x: big - 1, y: big }, { x: 1, y: 1 }), -1n);
  assert.equal(orient({ x: 0, y: 0 }, { x: big, y: big - 1 }, { x: 1, y: 1 }), 1n);
  assert.equal(orient({ x: 0, y: 0 }, { x: big, y: big }, { x: 1, y: 1 }), 0n);
});

test("onSegment: collinear point within and outside bounds", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 10, y: 0 };
  assert.ok(onSegment(a, b, { x: 5, y: 0 }));
  assert.ok(onSegment(a, b, { x: 0, y: 0 }));
  assert.ok(!onSegment(a, b, { x: 11, y: 0 }));
  assert.ok(!onSegment(a, b, { x: 5, y: 1 }));
});

test("segmentIntersection: proper crossing", () => {
  const hit = segmentIntersection(
    { x: 0, y: 0 },
    { x: 4, y: 4 },
    { x: 0, y: 4 },
    { x: 4, y: 0 },
  );
  assert.deepEqual(hit, { type: "cross" });
});

test("segmentIntersection: endpoint touch and T-junction touch", () => {
  assert.deepEqual(
    segmentIntersection({ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }),
    { type: "touch", point: { x: 4, y: 0 } },
  );
  assert.deepEqual(
    segmentIntersection({ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 3 }),
    { type: "touch", point: { x: 2, y: 0 } },
  );
});

test("segmentIntersection: collinear overlap, single-point touch, disjoint", () => {
  assert.deepEqual(
    segmentIntersection({ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 4, y: 0 }, { x: 10, y: 0 }),
    { type: "overlap", from: { x: 4, y: 0 }, to: { x: 6, y: 0 } },
  );
  assert.deepEqual(
    segmentIntersection({ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 0 }, { x: 8, y: 0 }),
    { type: "touch", point: { x: 4, y: 0 } },
  );
  assert.deepEqual(
    segmentIntersection({ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 5, y: 0 }, { x: 8, y: 0 }),
    { type: "none" },
  );
  // Collinear vertical overlap.
  assert.deepEqual(
    segmentIntersection({ x: 2, y: 0 }, { x: 2, y: 6 }, { x: 2, y: 3 }, { x: 2, y: 9 }),
    { type: "overlap", from: { x: 2, y: 3 }, to: { x: 2, y: 6 } },
  );
});

test("segmentIntersection: parallel and disjoint", () => {
  assert.deepEqual(
    segmentIntersection({ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 1 }, { x: 4, y: 1 }),
    { type: "none" },
  );
  assert.deepEqual(
    segmentIntersection({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }, { x: 3, y: 1 }),
    { type: "none" },
  );
});

test("pointInRing: exact inside/outside, including huge coordinates", () => {
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  assert.ok(pointInRing({ x: 5, y: 5 }, square));
  assert.ok(pointInRing({ x: 1, y: 9 }, square));
  assert.ok(!pointInRing({ x: 11, y: 5 }, square));
  assert.ok(!pointInRing({ x: -1, y: 5 }, square));

  // Concave ring.
  const concave = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 5, y: 5 },
    { x: 0, y: 10 },
  ];
  assert.ok(!pointInRing({ x: 5, y: 8 }, concave)); // inside the notch
  assert.ok(pointInRing({ x: 2, y: 3 }, concave));

  // Large coordinates where float64 division would lose precision.
  const B = 9007199254740990; // close to 2^53
  const bigTriangle = [
    { x: 0, y: 0 },
    { x: B, y: 0 },
    { x: 0, y: B },
  ];
  assert.ok(pointInRing({ x: 1, y: 1 }, bigTriangle));
  assert.ok(!pointInRing({ x: B - 1, y: B - 1 }, bigTriangle));
});

test("signedArea2: orientation and degeneracy", () => {
  const ccw = [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 4 },
    { x: 0, y: 4 },
  ];
  assert.equal(signedArea2(ccw), 32n);
  assert.equal(signedArea2([...ccw].reverse()), -32n);
  assert.equal(
    signedArea2([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ]),
    0n,
  );
});
