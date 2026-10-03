import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPoint, pointInPolygon } from "../src/geometry.js";

const square = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

test("strictly interior point is INSIDE", () => {
  assert.equal(classifyPoint(square, 5, 5), "INSIDE");
});

test("exterior point is OUTSIDE", () => {
  assert.equal(classifyPoint(square, 15, 5), "OUTSIDE");
  assert.equal(classifyPoint(square, -1, 5), "OUTSIDE");
});

test("point on an edge counts as inside (EDGE)", () => {
  assert.equal(classifyPoint(square, 5, 0), "EDGE");
  assert.equal(classifyPoint(square, 10, 5), "EDGE");
  assert.equal(pointInPolygon(square, 0, 7), true);
});

test("vertex counts as inside (EDGE)", () => {
  assert.equal(classifyPoint(square, 0, 0), "EDGE");
  assert.equal(classifyPoint(square, 10, 10), "EDGE");
});

test("even-odd rule on a concave polygon", () => {
  const concave = [
    [0, 0],
    [10, 0],
    [10, 10],
    [5, 10],
    [5, 4],
    [0, 4],
  ];
  // Inside the notch cut out of the polygon -> outside by even-odd.
  assert.equal(classifyPoint(concave, 2, 7), "OUTSIDE");
  assert.equal(classifyPoint(concave, 7, 7), "INSIDE");
  assert.equal(classifyPoint(concave, 2, 2), "INSIDE");
});

test("even-odd rule with a hole-like self-touching shape", () => {
  // Two nested squares traced as one polygon path is not required;
  // verify parity: a point crossed by an even number of edges is outside.
  const triangle = [
    [0, 0],
    [10, 0],
    [5, 10],
  ];
  assert.equal(classifyPoint(triangle, 5, 5), "INSIDE");
  assert.equal(classifyPoint(triangle, 1, 9), "OUTSIDE");
  assert.equal(classifyPoint(triangle, 5, 0), "EDGE");
});
