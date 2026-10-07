import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  vec,
  distSqPointToSegment,
  closestPointOnSegment,
  segmentsIntersect,
  polygonSelfIntersects,
} from "../src/index";

test("distSqPointToSegment: perpendicular, endpoint, and degenerate cases", () => {
  assert.equal(distSqPointToSegment(vec(5, 3), vec(0, 0), vec(10, 0)), 9);
  assert.equal(distSqPointToSegment(vec(-4, 0), vec(0, 0), vec(10, 0)), 16);
  assert.equal(distSqPointToSegment(vec(3, 4), vec(1, 1), vec(1, 1)), 13);
});

test("closestPointOnSegment clamps to the segment", () => {
  assert.deepEqual(closestPointOnSegment(vec(5, 3), vec(0, 0), vec(10, 0)), vec(5, 0));
  assert.deepEqual(closestPointOnSegment(vec(-4, 2), vec(0, 0), vec(10, 0)), vec(0, 0));
  assert.deepEqual(closestPointOnSegment(vec(99, 2), vec(0, 0), vec(10, 0)), vec(10, 0));
});

test("segmentsIntersect: crossing, touching, collinear, disjoint", () => {
  assert.ok(segmentsIntersect(vec(0, 0), vec(4, 4), vec(0, 4), vec(4, 0)));
  assert.ok(segmentsIntersect(vec(0, 0), vec(4, 0), vec(2, 0), vec(2, 5))); // T-touch
  assert.ok(segmentsIntersect(vec(0, 0), vec(4, 0), vec(2, 0), vec(6, 0))); // overlap
  assert.ok(!segmentsIntersect(vec(0, 0), vec(4, 0), vec(0, 1), vec(4, 1)));
  assert.ok(!segmentsIntersect(vec(0, 0), vec(1, 0), vec(2, 0), vec(3, 0))); // collinear gap
});

test("polygonSelfIntersects: square ok, bowtie and self-touch rejected", () => {
  assert.ok(!polygonSelfIntersects([vec(0, 0), vec(10, 0), vec(10, 10), vec(0, 10)]));
  assert.ok(polygonSelfIntersects([vec(0, 0), vec(10, 10), vec(10, 0), vec(0, 10)]));
  // vertex 1 lies on the non-adjacent edge e2 -> self-touch
  assert.ok(polygonSelfIntersects([vec(0, 0), vec(5, 10), vec(10, 10), vec(0, 10)]));
  // zero-length edge
  assert.ok(polygonSelfIntersects([vec(0, 0), vec(0, 0), vec(10, 10), vec(0, 10)]));
});
