import { test } from "node:test";
import assert from "node:assert/strict";
import { Instance, solve } from "../src/solver.js";
import { validateCertificate } from "../src/verify.js";

test("single item that fits is placed", () => {
  const inst: Instance = {
    grid: { width: 3, height: 3 },
    items: [{ id: "A", w: 2, h: 2, profit: 5 }],
  };
  const sol = solve(inst);
  assert.equal(sol.profit, 5);
  assert.equal(sol.area, 4);
  assert.equal(sol.placements.length, 1);
  assert.deepEqual(validateCertificate(inst, sol), []);
});

test("item larger than grid is skipped", () => {
  const inst: Instance = {
    grid: { width: 2, height: 2 },
    items: [{ id: "A", w: 3, h: 1, profit: 5 }],
  };
  const sol = solve(inst);
  assert.equal(sol.profit, 0);
  assert.equal(sol.placements.length, 0);
});

test("rotation allowed per item only when rotate=true", () => {
  // 1x3 item in a 3x1 grid: fits only when rotated
  const withRot: Instance = {
    grid: { width: 3, height: 1 },
    items: [{ id: "A", w: 1, h: 3, profit: 7, rotate: true }],
  };
  const solRot = solve(withRot);
  assert.equal(solRot.profit, 7);
  assert.equal(solRot.placements[0].rotated, true);

  const noRot: Instance = {
    grid: { width: 3, height: 1 },
    items: [{ id: "A", w: 1, h: 3, profit: 7 }],
  };
  assert.equal(solve(noRot).profit, 0);
});

test("forbidden cells are never covered", () => {
  const inst: Instance = {
    grid: { width: 4, height: 4, forbidden: [[0, 0], [1, 1], [2, 2], [3, 3]] },
    items: [
      { id: "A", w: 2, h: 2, profit: 10 },
      { id: "B", w: 4, h: 4, profit: 100 }, // impossible: covers forbidden cells
    ],
  };
  const sol = solve(inst);
  assert.equal(sol.profit, 10);
  assert.deepEqual(validateCertificate(inst, sol), []);
});

test("max-profit subset wins over placing everything", () => {
  // Two 2x2 items in a 4x2 grid both fit; adding a third 2x2 is impossible,
  // so the solver must drop the least profitable one.
  const inst: Instance = {
    grid: { width: 4, height: 2 },
    items: [
      { id: "A", w: 2, h: 2, profit: 5 },
      { id: "B", w: 2, h: 2, profit: 4 },
      { id: "C", w: 2, h: 2, profit: 3 },
    ],
  };
  const sol = solve(inst);
  assert.equal(sol.profit, 9);
  assert.deepEqual(sol.placements.map((p) => p.id).sort(), ["A", "B"]);
});

test("tie on profit is broken by smaller covered area", () => {
  // A(1x1,p=3) vs B(2x2,p=3): same profit, A covers less area.
  const inst: Instance = {
    grid: { width: 2, height: 2 },
    items: [
      { id: "A", w: 1, h: 1, profit: 3 },
      { id: "B", w: 2, h: 2, profit: 3 },
    ],
  };
  const sol = solve(inst);
  assert.equal(sol.profit, 3);
  assert.equal(sol.area, 1);
  assert.equal(sol.placements[0].id, "A");
});

test("negative-profit items are never placed", () => {
  const inst: Instance = {
    grid: { width: 3, height: 3 },
    items: [
      { id: "A", w: 1, h: 1, profit: -5 },
      { id: "B", w: 1, h: 1, profit: 1 },
    ],
  };
  const sol = solve(inst);
  assert.equal(sol.profit, 1);
  assert.deepEqual(sol.placements.map((p) => p.id), ["B"]);
});

test("input validation rejects bad instances", () => {
  assert.throws(() => solve({ grid: { width: 9, height: 1 }, items: [] }), /grid/);
  assert.throws(
    () => solve({ grid: { width: 2, height: 2 }, items: Array(11).fill(null).map((_, i) => ({ id: `i${i}`, w: 1, h: 1, profit: 1 })) }),
    /at most 10/,
  );
  assert.throws(
    () => solve({ grid: { width: 2, height: 2, forbidden: [[5, 0]] }, items: [] }),
    /forbidden/,
  );
});

test("identical items with different profits: best subset is relabeled correctly", () => {
  // three 2x2 items, only two fit in a 4x4 grid alongside nothing else;
  // the solver must pick the two most profitable ones
  const inst: Instance = {
    grid: { width: 4, height: 2 },
    items: [
      { id: "A", w: 2, h: 2, profit: 1 },
      { id: "B", w: 2, h: 2, profit: 2 },
      { id: "C", w: 2, h: 2, profit: 3 },
    ],
  };
  const sol = solve(inst);
  assert.equal(sol.profit, 5);
  assert.deepEqual(sol.placements.map((p) => p.id).sort(), ["B", "C"]);
  assert.deepEqual(validateCertificate(inst, sol), []);
});

test("stress: ten identical 3x3 on 8x8 solves quickly (max 4 fit)", () => {
  const inst: Instance = {
    grid: { width: 8, height: 8 },
    items: Array.from({ length: 10 }, (_, i) => ({ id: `i${i}`, w: 3, h: 3, profit: 9 })),
  };
  const t0 = Date.now();
  const sol = solve(inst);
  assert.ok(Date.now() - t0 < 5000, "should be fast");
  assert.equal(sol.profit, 36); // 4 squares, verified against exhaustive search
  assert.deepEqual(validateCertificate(inst, sol), []);
});
