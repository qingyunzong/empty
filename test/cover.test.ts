import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { enumerateCover, solveCover } from "../src/cover.js";
import type { Problem } from "../src/types.js";
import { randomProblem, rng } from "./helpers.js";

function problem(partial: Partial<Problem>): Problem {
  return {
    range: { start: 0, end: 100 },
    receiver: [],
    memoryLimit: 100000,
    maxPackages: 20,
    packages: [],
    ...partial,
  };
}

test("picks the cheaper single package over two overlapping ones", () => {
  const p = problem({
    receiver: [{ start: 0, end: 20 }],
    packages: [
      { id: "A", cover: [{ start: 20, end: 60 }], bytes: 30, dictBytes: 0, needs: [] },
      { id: "B", cover: [{ start: 60, end: 100 }], bytes: 30, dictBytes: 0, needs: [] },
      { id: "C", cover: [{ start: 20, end: 100 }], bytes: 50, dictBytes: 0, needs: [] },
    ],
  });
  const r = solveCover(p);
  ok(r.feasible);
  deepEqual(r.selected, ["C"]);
  equal(r.totalBytes, 50);
});

test("overlap is allowed and each package's cost is counted once", () => {
  const p = problem({
    packages: [
      { id: "A", cover: [{ start: 0, end: 80 }], bytes: 40, dictBytes: 0, needs: [] },
      { id: "B", cover: [{ start: 50, end: 100 }], bytes: 40, dictBytes: 0, needs: [] },
      { id: "C", cover: [{ start: 0, end: 100 }], bytes: 100, dictBytes: 0, needs: [] },
    ],
  });
  const r = solveCover(p);
  ok(r.feasible);
  equal(r.totalBytes, 80); // A+B overlap on [50,80) but each pays once
  deepEqual([...r.selected].sort(), ["A", "B"]);
});

test("respects the maxPackages budget", () => {
  const base = problem({
    packages: [
      { id: "A", cover: [{ start: 0, end: 50 }], bytes: 10, dictBytes: 0, needs: [] },
      { id: "B", cover: [{ start: 50, end: 100 }], bytes: 10, dictBytes: 0, needs: [] },
      { id: "C", cover: [{ start: 0, end: 100 }], bytes: 50, dictBytes: 0, needs: [] },
    ],
  });
  const capped = { ...base, maxPackages: 1 };
  const r = solveCover(capped);
  ok(r.feasible);
  deepEqual(r.selected, ["C"]);
  equal(r.totalBytes, 50);
});

test("reports infeasible when a gap is uncoverable", () => {
  const p = problem({
    packages: [
      { id: "A", cover: [{ start: 0, end: 60 }], bytes: 10, dictBytes: 0, needs: [] },
    ],
  });
  const r = solveCover(p);
  ok(!r.feasible);
  ok(r.reason.includes("[60,100)"), r.reason);
});

test("reports infeasible when the package budget is too small", () => {
  const p = problem({
    maxPackages: 1,
    packages: [
      { id: "A", cover: [{ start: 0, end: 40 }], bytes: 10, dictBytes: 0, needs: [] },
      { id: "B", cover: [{ start: 60, end: 100 }], bytes: 10, dictBytes: 0, needs: [] },
    ],
  });
  const r = solveCover(p);
  ok(!r.feasible);
});

test("identical-coverage packages are atomic: cheaper one taken whole", () => {
  const p = problem({
    packages: [
      { id: "A", cover: [{ start: 0, end: 100 }], bytes: 90, dictBytes: 0, needs: [] },
      { id: "B", cover: [{ start: 0, end: 100 }], bytes: 70, dictBytes: 0, needs: [] },
    ],
  });
  const r = solveCover(p);
  ok(r.feasible);
  deepEqual(r.selected, ["B"]);
  equal(r.totalBytes, 70);
});

test("empty gaps need no packages", () => {
  const p = problem({ receiver: [{ start: 0, end: 100 }] });
  const r = solveCover(p);
  ok(r.feasible);
  deepEqual(r.selected, []);
  equal(r.totalBytes, 0);
});

test("assignment tiles the gaps and lists covering packages", async () => {
  const p = problem({
    receiver: [{ start: 10, end: 20 }],
    packages: [
      { id: "A", cover: [{ start: 0, end: 30 }], bytes: 10, dictBytes: 0, needs: [] },
      { id: "B", cover: [{ start: 20, end: 100 }], bytes: 10, dictBytes: 0, needs: [] },
    ],
  });
  const r = solveCover(p);
  ok(r.feasible);
  deepEqual(r.gaps, [{ start: 0, end: 10 }, { start: 20, end: 100 }]);
  const { normalize } = await import("../src/intervals.js");
  deepEqual(normalize(r.assignment.map((a) => a.interval)), r.gaps);
  for (const a of r.assignment) ok(a.packages.length >= 1);
});

test("DP solver matches exhaustive subset enumeration on random small instances", () => {
  const rand = rng(12345);
  for (let t = 0; t < 40; t++) {
    const p = randomProblem(rand, { packages: 4 + Math.floor(rand() * 6) });
    const dp = solveCover(p);
    const en = enumerateCover(p);
    ok(en.checked, "enumeration should run for small inputs");
    equal(dp.feasible, en.feasible, `feasibility mismatch on trial ${t}`);
    if (dp.feasible) {
      equal(dp.totalBytes, en.bestBytes, `cost mismatch on trial ${t}`);
    }
  }
});

test("DP solver matches enumeration under tight package budgets", () => {
  const rand = rng(777);
  for (let t = 0; t < 30; t++) {
    const p = randomProblem(rand, { packages: 6 });
    p.maxPackages = 1 + Math.floor(rand() * 3);
    const dp = solveCover(p);
    const en = enumerateCover(p);
    equal(dp.feasible, en.feasible, `feasibility mismatch on trial ${t}`);
    if (dp.feasible) equal(dp.totalBytes, en.bestBytes, `cost mismatch on trial ${t}`);
  }
});
