import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import {
  closestPointOnSegment,
  findSelfIntersection,
  roundPoint,
  segmentsIntersect,
} from "../src/geometry";

test("closestPointOnSegment projects onto the interior", () => {
  const c = closestPointOnSegment({ x: 4, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 });
  deepEqual(c.point, { x: 4, y: 0 });
  equal(c.dist2, 9);
  equal(c.t, 0.4);
});

test("closestPointOnSegment clamps to endpoints", () => {
  const c = closestPointOnSegment({ x: -2, y: 1 }, { x: 0, y: 0 }, { x: 10, y: 0 });
  deepEqual(c.point, { x: 0, y: 0 });
  equal(c.dist2, 5);
});

test("roundPoint snaps to integer coordinates", () => {
  deepEqual(roundPoint({ x: 2.5, y: -1.5 }), { x: 3, y: -1 });
  deepEqual(roundPoint({ x: 2.4, y: 1.6 }), { x: 2, y: 2 });
});

test("segmentsIntersect detects crossings and touches", () => {
  ok(segmentsIntersect({ x: 0, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }, { x: 4, y: 0 }));
  ok(segmentsIntersect({ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }));
  ok(segmentsIntersect({ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 0 }, { x: 6, y: 0 }));
  ok(!segmentsIntersect({ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 1 }, { x: 4, y: 1 }));
});

test("findSelfIntersection ignores adjacent edges, flags real crossings", () => {
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  equal(findSelfIntersection(square, 0), null);

  // Move vertex 0 into the interior so its incident edges cross edge 2.
  const bowtie = [
    { x: 5, y: 12 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  const hit = findSelfIntersection(bowtie, 0);
  ok(hit !== null);
  equal(hit!.otherEdge, 2);
});
