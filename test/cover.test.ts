import { test } from "node:test";
import assert from "node:assert/strict";
import { computeGaps, mergeIntervals } from "../src/gaps";
import { buildBundles, elementarySegments, minCostCover, bruteForceCover, bundleSegmentRanges } from "../src/cover";
import type { Pkg } from "../src/model";
import { mulberry32, randInt } from "./helpers";

function pkg(id: string, l: number, r: number, bytes: number, dict = 0, deps: string[] = []): Pkg {
  return { id, coverL: l, coverR: r, bytes, dict, deps };
}

test("gaps: union of covers minus existing", () => {
  assert.deepEqual(computeGaps([[0, 5]], [[0, 10]]), [[6, 10]]);
  assert.deepEqual(computeGaps([[0, 3], [8, 20]], [[0, 10]]), [[4, 7]]);
  assert.deepEqual(computeGaps([[0, 100]], [[0, 10]]), []);
  assert.deepEqual(computeGaps([], [[0, 2], [4, 5]]), [[0, 2], [4, 5]]);
});

test("mergeIntervals merges overlaps and adjacency", () => {
  assert.deepEqual(mergeIntervals([[5, 7], [0, 2], [3, 4], [10, 12], [12, 15]]), [[0, 7], [10, 15]]);
});

test("cover: overlapping packages are paid once", () => {
  const pkgs = [pkg("a", 0, 10, 5), pkg("b", 5, 15, 5), pkg("c", 0, 15, 12)];
  const bundles = buildBundles(pkgs);
  const gaps = computeGaps([], pkgs.map((p) => [p.coverL, p.coverR]));
  const segs = elementarySegments(gaps, bundles);
  const res = minCostCover(segs, bundles, 20);
  assert.equal(res.feasible, true);
  assert.equal(res.totalBytes, 10); // a+b, overlap [5,10] free
  assert.equal(res.chosen.length, 2);
});

test("cover: identical-coverage packages are indivisible", () => {
  const pkgs = [pkg("x1", 0, 5, 1), pkg("x2", 0, 5, 2), pkg("z", 0, 2, 2), pkg("w", 3, 5, 2)];
  const bundles = buildBundles(pkgs);
  assert.equal(bundles.length, 3); // {x1,x2}, {z}, {w}
  const gaps = computeGaps([], pkgs.map((p) => [p.coverL, p.coverR]));
  const segs = elementarySegments(gaps, bundles);
  const res = minCostCover(segs, bundles, 20);
  assert.equal(res.totalBytes, 3); // bundle {x1,x2} at 1+2 beats z+w at 4
  const members = res.chosen.flatMap((b) => bundles[b]!.members.map((m) => m.id)).sort();
  assert.deepEqual(members, ["x1", "x2"]); // both or neither
});

test("cover: package-count limit can make the instance infeasible", () => {
  const pkgs = [pkg("a", 0, 1, 1), pkg("b", 5, 6, 1), pkg("c", 10, 11, 1)];
  const bundles = buildBundles(pkgs);
  const gaps = computeGaps([], pkgs.map((p) => [p.coverL, p.coverR]));
  const segs = elementarySegments(gaps, bundles);
  assert.equal(minCostCover(segs, bundles, 2).feasible, false);
  const ok = minCostCover(segs, bundles, 3);
  assert.equal(ok.feasible, true);
  assert.equal(ok.totalBytes, 3);
});

test("cover: empty gaps need no packages", () => {
  const pkgs = [pkg("a", 0, 10, 5)];
  const bundles = buildBundles(pkgs);
  const gaps = computeGaps([[0, 10]], [[0, 10]]);
  const segs = elementarySegments(gaps, bundles);
  const res = minCostCover(segs, bundles, 20);
  assert.equal(res.feasible, true);
  assert.equal(res.totalBytes, 0);
  assert.equal(res.chosen.length, 0);
});

test("cover: DP matches brute-force subset enumeration on random small instances", () => {
  const rng = mulberry32(20261005);
  for (let iter = 0; iter < 400; iter++) {
    const n = randInt(rng, 1, 10);
    const pkgs: Pkg[] = [];
    for (let i = 0; i < n; i++) {
      const l = randInt(rng, 0, 20);
      pkgs.push(pkg(`p${i}`, l, l + randInt(rng, 0, 8), randInt(rng, 1, 15), randInt(rng, 0, 6)));
    }
    const existing: Array<[number, number]> = [];
    for (let i = 0, k = randInt(rng, 0, 3); i < k; i++) {
      const l = randInt(rng, 0, 25);
      existing.push([l, l + randInt(rng, 0, 5)]);
    }
    const maxPackages = randInt(rng, 1, 6);
    const bundles = buildBundles(pkgs);
    const gaps = computeGaps(existing, pkgs.map((p) => [p.coverL, p.coverR]));
    const segs = elementarySegments(gaps, bundles);
    const dp = minCostCover(segs, bundles, maxPackages);
    const bf = bruteForceCover(segs, bundles, maxPackages)!;
    assert.equal(dp.feasible, bf.feasible, `feasibility mismatch at iter ${iter}`);
    if (dp.feasible) {
      assert.equal(dp.totalBytes, bf.totalBytes, `cost mismatch at iter ${iter}`);
      // The DP certificate must genuinely cover every segment.
      const ranges = bundleSegmentRanges(segs, bundles);
      const covered = new Array(segs.length).fill(false);
      for (const b of dp.chosen) {
        const rg = ranges[b]!;
        for (let s = rg![0]; s <= rg![1]; s++) covered[s] = true;
      }
      assert.ok(covered.every(Boolean), `DP certificate leaves a segment uncovered at iter ${iter}`);
      assert.ok(dp.packageCount <= maxPackages);
    }
  }
});
