import test from "node:test";
import assert from "node:assert";
import {
  Conflict,
  Polygon,
  edgeIntersectionConflicts,
  validatePolygon,
} from "../src/polygon";
import { mulberry32, oracleConflictingPairs, oracleVerdict } from "./oracle";

const SQUARE_WITH_HOLE: Polygon = {
  outer: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ],
  holes: [
    [
      { x: 2, y: 2 },
      { x: 4, y: 2 },
      { x: 4, y: 4 },
      { x: 2, y: 4 },
    ],
  ],
};

function pairKey(c: Conflict): string {
  if (c.kind === "self-intersection" || c.kind === "ring-intersection") {
    return `${c.a.ring}.${c.a.edge}/${c.b.ring}.${c.b.edge}`;
  }
  return c.kind;
}

test("valid polygon with a hole passes full validation", () => {
  assert.deepEqual(validatePolygon(SQUARE_WITH_HOLE), []);
});

test("self-intersecting outer ring is rejected with concrete edge evidence", () => {
  const bowtie: Polygon = {
    outer: [
      { x: 0, y: 0 },
      { x: 2, y: 6 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
    ],
    holes: [],
  };
  const conflicts = validatePolygon(bowtie);
  assert.equal(conflicts.length, 1);
  const c = conflicts[0]!;
  assert.equal(c.kind, "self-intersection");
  if (c.kind === "self-intersection") {
    assert.deepEqual(c.a, { ring: 0, edge: 0 });
    assert.deepEqual(c.b, { ring: 0, edge: 2 });
    assert.equal(c.intersection.type, "cross");
    assert.match(c.message, /outer edge 0 .*crosses outer edge 2/);
  }
});

test("touching counts as a conflict (vertex resting on another edge)", () => {
  const touching: Polygon = {
    outer: [
      { x: 0, y: 0 },
      { x: 2, y: 4 }, // lies exactly on edge (4,4)-(0,4)
      { x: 4, y: 4 },
      { x: 0, y: 4 },
    ],
    holes: [],
  };
  const conflicts = validatePolygon(touching);
  // Two violations: edge 0 touches edge 2 at (2,4), and edge 1 overlaps
  // edge 2 along y = 4 (both are reported, with concrete edge evidence).
  assert.equal(conflicts.length, 2);
  const touch = conflicts.find(
    (c) => c.kind === "self-intersection" && c.intersection.type === "touch",
  );
  if (!touch) assert.fail("no touch conflict reported");
  if (touch.kind === "self-intersection" && touch.intersection.type === "touch") {
    assert.deepEqual(touch.a, { ring: 0, edge: 0 });
    assert.deepEqual(touch.b, { ring: 0, edge: 2 });
    assert.deepEqual(touch.intersection.point, { x: 2, y: 4 });
  }
  const overlap = conflicts.find(
    (c) => c.kind === "self-intersection" && c.intersection.type === "overlap",
  );
  assert.ok(overlap);
});

test("collinear spike (backtracking edge) is rejected as overlap", () => {
  const spike: Polygon = {
    outer: [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 2, y: 0 }, // backtracks along edge 0
      { x: 0, y: 4 },
    ],
    holes: [],
  };
  const conflicts = validatePolygon(spike);
  assert.ok(conflicts.length >= 1);
  const c = conflicts[0]!;
  assert.equal(c.kind, "self-intersection");
  if (c.kind === "self-intersection") {
    assert.equal(c.intersection.type, "overlap");
  }
});

test("straight collinear vertex (no spike) is allowed", () => {
  const poly: Polygon = {
    outer: [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
    ],
    holes: [],
  };
  assert.deepEqual(validatePolygon(poly), []);
});

test("hole escaping the outer ring is rejected", () => {
  const escaped: Polygon = {
    ...SQUARE_WITH_HOLE,
    holes: [
      [
        { x: 20, y: 20 },
        { x: 24, y: 20 },
        { x: 24, y: 24 },
        { x: 20, y: 24 },
      ],
    ],
  };
  const conflicts = validatePolygon(escaped);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]!.kind, "hole-outside-outer");
  if (conflicts[0]!.kind === "hole-outside-outer") {
    assert.equal(conflicts[0]!.hole, 0);
  }
});

test("hole crossing the outer boundary reports the exact edge pair", () => {
  const crossing: Polygon = {
    ...SQUARE_WITH_HOLE,
    holes: [
      [
        { x: 8, y: 2 },
        { x: 14, y: 2 }, // sticks out through outer edge (10,0)-(10,10)
        { x: 14, y: 4 },
        { x: 8, y: 4 },
      ],
    ],
  };
  const conflicts = validatePolygon(crossing);
  assert.ok(conflicts.length >= 2);
  for (const c of conflicts) {
    assert.equal(c.kind, "ring-intersection");
    if (c.kind === "ring-intersection") {
      assert.equal(c.a.ring, 0);
      assert.equal(c.a.edge, 1); // outer edge (10,0)-(10,10)
      assert.equal(c.b.ring, 1);
      assert.equal(c.intersection.type, "cross");
    }
  }
});

test("hole merely touching the outer ring is a conflict", () => {
  const touchingHole: Polygon = {
    ...SQUARE_WITH_HOLE,
    holes: [
      [
        { x: 0, y: 2 }, // touches outer edge (0,10)-(0,0)
        { x: 4, y: 2 },
        { x: 4, y: 4 },
        { x: 0, y: 4 },
      ],
    ],
  };
  const conflicts = validatePolygon(touchingHole);
  assert.ok(conflicts.length >= 1);
  const c = conflicts[0]!;
  assert.equal(c.kind, "ring-intersection");
  if (c.kind === "ring-intersection") {
    assert.equal(c.intersection.type, "touch");
  }
});

test("nested hole is rejected", () => {
  const nested: Polygon = {
    ...SQUARE_WITH_HOLE,
    holes: [
      [
        { x: 1, y: 1 },
        { x: 8, y: 1 },
        { x: 8, y: 8 },
        { x: 1, y: 8 },
      ],
      [
        { x: 3, y: 3 },
        { x: 5, y: 3 },
        { x: 5, y: 5 },
        { x: 3, y: 5 },
      ],
    ],
  };
  const conflicts = validatePolygon(nested);
  assert.ok(conflicts.some((c) => c.kind === "nested-hole"));
});

test("two disjoint holes inside the outer ring are fine", () => {
  const twoHoles: Polygon = {
    ...SQUARE_WITH_HOLE,
    holes: [
      [
        { x: 1, y: 1 },
        { x: 3, y: 1 },
        { x: 3, y: 3 },
        { x: 1, y: 3 },
      ],
      [
        { x: 6, y: 6 },
        { x: 8, y: 6 },
        { x: 8, y: 8 },
        { x: 6, y: 8 },
      ],
    ],
  };
  assert.deepEqual(validatePolygon(twoHoles), []);
});

test("structural problems: non-integer, zero-length edge, degenerate ring", () => {
  const nonInteger: Polygon = {
    outer: [
      { x: 0, y: 0 },
      { x: 4.5, y: 0 },
      { x: 4, y: 4 },
    ],
    holes: [],
  };
  const c1 = validatePolygon(nonInteger);
  assert.equal(c1.length, 1);
  assert.equal(c1[0]!.kind, "invalid-coordinate");
  if (c1[0]!.kind === "invalid-coordinate") {
    assert.equal(c1[0]!.vertex, 1);
  }

  const zeroEdge: Polygon = {
    outer: [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 0, y: 4 },
    ],
    holes: [],
  };
  const c2 = validatePolygon(zeroEdge);
  assert.ok(c2.some((c) => c.kind === "degenerate-ring"));

  const line: Polygon = {
    outer: [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ],
    holes: [],
  };
  // A fully collinear "ring" necessarily backtracks, so the all-edge-pairs
  // scan reports it as overlapping (self-intersecting) edges.
  const c3 = validatePolygon(line);
  assert.ok(c3.length >= 1);
  for (const c of c3) {
    assert.equal(c.kind, "self-intersection");
    if (c.kind === "self-intersection") {
      assert.equal(c.intersection.type, "overlap");
    }
  }
});

test("fuzz: all-edge-pairs scan matches an independent brute-force oracle", () => {
  const rand = mulberry32(0x5eed);
  const int = (lo: number, hi: number) =>
    lo + Math.floor(rand() * (hi - lo + 1));
  for (let iter = 0; iter < 400; iter++) {
    const ring = (n: number) =>
      Array.from({ length: n }, () => ({ x: int(-6, 6), y: int(-6, 6) }));
    const poly: Polygon = {
      outer: ring(int(3, 8)),
      holes: Array.from({ length: int(0, 2) }, () => ring(int(3, 6))),
    };
    const libPairs = new Set(
      edgeIntersectionConflicts(poly)
        .filter(
          (c) => c.kind === "self-intersection" || c.kind === "ring-intersection",
        )
        .map(pairKey),
    );
    const oraclePairs = oracleConflictingPairs(poly);
    assert.deepEqual(
      libPairs,
      oraclePairs,
      `iteration ${iter}: ${JSON.stringify(poly)}`,
    );
  }
});

test("fuzz: full validation verdict matches the oracle", () => {
  const rand = mulberry32(0xc0ffee);
  const int = (lo: number, hi: number) =>
    lo + Math.floor(rand() * (hi - lo + 1));
  let validCount = 0;
  for (let iter = 0; iter < 400; iter++) {
    const ring = (n: number) =>
      Array.from({ length: n }, () => ({ x: int(-8, 8), y: int(-8, 8) }));
    const poly: Polygon = {
      outer: ring(int(3, 9)),
      holes: Array.from({ length: int(0, 2) }, () => ring(int(3, 6))),
    };
    const oracle = oracleVerdict(poly);
    const libValid = validatePolygon(poly).length === 0;
    assert.equal(
      libValid,
      oracle.valid,
      `iteration ${iter}: ${JSON.stringify(poly)} oracle=${JSON.stringify({
        structural: oracle.structuralProblems,
        pairs: [...oracle.pairs],
        outside: oracle.holesOutsideOuter,
        nested: oracle.nestedHoles,
      })}`,
    );
    if (libValid) validCount++;
  }
  // Sanity: the fuzzer must produce both valid and invalid polygons.
  assert.ok(validCount > 0, "fuzzer produced no valid polygons");
  assert.ok(validCount < 400, "fuzzer produced only valid polygons");
});
