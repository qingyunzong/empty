import { test } from "node:test";
import assert from "node:assert/strict";
import { Rat, parseRat } from "../src/rational";
import { Poly, mulPoly } from "../src/poly";
import { powerToBernstein } from "../src/bezier";
import { solve, SolveResult } from "../src/solve";
import { run } from "../src/cli";

const LINE_Y0 = { a: Rat.zero(), b: Rat.one(), c: Rat.zero() };

/** Cubic Bezier segment with x(t) = t and y(t) = p(t) for a power-basis poly p (deg <= 3). */
function segmentFromYPoly(p: Poly): [Rat, Rat][] {
  const y = powerToBernstein(p, 3);
  return [0, 1, 2, 3].map((i) => [Rat.of(i, 3), y[i]!] as [Rat, Rat]);
}

function lin(r: string): Poly {
  return [parseRat(r).neg(), Rat.one()]; // t - r
}

function mulAll(ps: Poly[]): Poly {
  return ps.reduce((acc, p) => mulPoly(acc, p), [Rat.one()]);
}

function knownRootCheck(
  result: SolveResult,
  known: { r: string; mult: number }[],
  segment = 0,
) {
  for (const { r, mult } of known) {
    const want = parseRat(r);
    const hits = result.roots.filter((root) => {
      if (root.segment !== segment) return false;
      const lo = parseRat(root.t[0]);
      const hi = parseRat(root.t[1]);
      return lo.lte(want) && want.lte(hi);
    });
    assert.equal(hits.length, 1, `root ${r} must be covered by exactly one interval`);
    assert.equal(hits[0]!.multiplicity, mult, `root ${r} multiplicity`);
  }
  const total = result.roots
    .filter((root) => root.segment === segment)
    .reduce((s, root) => s + root.multiplicity, 0);
  assert.equal(
    total,
    known.reduce((s, k) => s + k.mult, 0),
    "no extra or missing roots (sum of multiplicities)",
  );
}

test("three simple dyadic roots are found exactly with multiplicity 1", () => {
  const p = mulAll([lin("1/4"), lin("1/2"), lin("3/4")]);
  const res = solve([segmentFromYPoly(p)], LINE_Y0);
  assert.equal(res.unknown.length, 0);
  assert.ok(res.budget.closed);
  knownRootCheck(res, [
    { r: "1/4", mult: 1 },
    { r: "1/2", mult: 1 },
    { r: "3/4", mult: 1 },
  ]);
  for (const root of res.roots) assert.ok(root.exact, "dyadic roots reported exactly");
});

test("three simple non-dyadic roots are isolated in tight disjoint intervals", () => {
  const p = mulAll([lin("1/3"), lin("2/5"), lin("3/7")]);
  const res = solve([segmentFromYPoly(p)], LINE_Y0);
  assert.equal(res.unknown.length, 0);
  knownRootCheck(res, [
    { r: "1/3", mult: 1 },
    { r: "2/5", mult: 1 },
    { r: "3/7", mult: 1 },
  ]);
  const tol = Rat.of(1n, 2n ** 24n);
  const intervals = res.roots.map((root) => [parseRat(root.t[0]), parseRat(root.t[1])]);
  for (const [lo, hi] of intervals) {
    assert.ok(hi!.sub(lo!).lte(tol), `interval width within tol: ${lo}..${hi}`);
  }
  intervals.sort((a, b) => a[0]!.cmp(b[0]!));
  for (let i = 1; i < intervals.length; i++) {
    assert.ok(intervals[i - 1]![1]!.lte(intervals[i]![0]!), "intervals are disjoint");
  }
});

test("double root gets multiplicity 2, companion simple root multiplicity 1", () => {
  const p = mulAll([lin("1/2"), lin("1/2"), lin("1/4")]);
  const res = solve([segmentFromYPoly(p)], LINE_Y0);
  assert.equal(res.unknown.length, 0);
  knownRootCheck(res, [
    { r: "1/2", mult: 2 },
    { r: "1/4", mult: 1 },
  ]);
});

test("triple root gets multiplicity 3", () => {
  const p = mulAll([lin("1/2"), lin("1/2"), lin("1/2")]);
  const res = solve([segmentFromYPoly(p)], LINE_Y0);
  assert.equal(res.roots.length, 1);
  knownRootCheck(res, [{ r: "1/2", mult: 3 }]);
});

test("double root at endpoint t=0 and simple root at t=1", () => {
  const p = mulAll([lin("0"), lin("0"), lin("1")]);
  const res = solve([segmentFromYPoly(p)], LINE_Y0);
  assert.equal(res.unknown.length, 0);
  knownRootCheck(res, [
    { r: "0", mult: 2 },
    { r: "1", mult: 1 },
  ]);
});

test("segment lying on the line is reported as an interval", () => {
  const res = solve([segmentFromYPoly([])], LINE_Y0);
  assert.equal(res.roots.length, 0);
  assert.deepEqual(res.onLine, [{ segment: 0, t: ["0", "1"], globalT: ["0", "1"] }]);
});

test("general (non-axis) line: x - y = 0 against y = t^2", () => {
  const seg = segmentFromYPoly([Rat.zero(), Rat.zero(), Rat.one()]); // y = t^2
  const res = solve([seg], { a: Rat.one(), b: Rat.of(-1), c: Rat.zero() });
  knownRootCheck(res, [
    { r: "0", mult: 1 },
    { r: "1", mult: 1 },
  ]);
});

test("multi-segment spline: roots carry segment-local and global parameters", () => {
  const segs = [
    segmentFromYPoly(lin("1/2")),
    segmentFromYPoly([]), // whole segment on the line
    segmentFromYPoly(mulAll([lin("1/4"), lin("3/4")])),
  ];
  const res = solve(segs, LINE_Y0);
  assert.equal(res.unknown.length, 0);
  assert.deepEqual(res.onLine, [{ segment: 1, t: ["0", "1"], globalT: ["1", "2"] }]);
  knownRootCheck(res, [{ r: "1/2", mult: 1 }], 0);
  knownRootCheck(res, [
    { r: "1/4", mult: 1 },
    { r: "3/4", mult: 1 },
  ], 2);
  const globals = res.roots.map((r) => r.globalT);
  assert.deepEqual(globals, [
    ["1/2", "1/2"],
    ["9/4", "9/4"],
    ["11/4", "11/4"],
  ]);
});

test("curve with no intersection reports nothing and stays closed", () => {
  // y = t^2 - t + 1/2 > 0 on [0, 1]
  const p: Poly = [Rat.of(1, 2), Rat.of(-1), Rat.one()];
  const res = solve([segmentFromYPoly(p)], LINE_Y0);
  assert.equal(res.roots.length, 0);
  assert.equal(res.onLine.length, 0);
  assert.equal(res.unknown.length, 0);
  assert.ok(res.budget.closed);
});

test("exhausted budget marks unresolved regions as unknown", () => {
  const p = mulAll([lin("1/3"), lin("2/5"), lin("3/7")]);
  const res = solve([segmentFromYPoly(p)], LINE_Y0, { budget: 1 });
  assert.ok(!res.budget.closed);
  assert.ok(res.unknown.length > 0, "unresolved intervals reported as unknown");
  const bound = res.unknown.reduce((s, u) => s + u.maxRoots, 0);
  assert.ok(bound >= 3, "unknown intervals still bound the root count");
});

test("zero budget leaves everything unknown", () => {
  const p = mulAll([lin("1/4"), lin("1/2"), lin("3/4")]);
  const res = solve([segmentFromYPoly(p)], LINE_Y0, { budget: 0 });
  assert.ok(!res.budget.closed);
  assert.equal(res.roots.length, 0);
  assert.ok(res.unknown.length > 0);
});

test("rejects more than 8 segments", () => {
  const segs = Array.from({ length: 9 }, () => segmentFromYPoly(lin("1/2")));
  assert.throws(() => solve(segs, LINE_Y0), /8/);
});

test("CLI end-to-end: triple root at t=1/2 from JSON input", () => {
  const input = {
    segments: [{ points: [[0, -1], [1, 1], [2, -1], [3, 1]] }],
    line: { a: 0, b: 1, c: 0 },
  };
  const res = run(JSON.parse(JSON.stringify(input)));
  assert.equal(res.roots.length, 1);
  assert.equal(res.roots[0]!.multiplicity, 3);
  assert.deepEqual(res.roots[0]!.t, ["1/2", "1/2"]);
});
