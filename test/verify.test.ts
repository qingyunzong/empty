import { test } from "node:test";
import assert from "node:assert/strict";
import { Instance, solve } from "../src/solver.js";
import { bruteForceOptimum, validateCertificate, verifyInstance } from "../src/verify.js";

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInstance(rand: () => number): Instance {
  const width = 1 + Math.floor(rand() * 5);  // 1..5
  const height = 1 + Math.floor(rand() * 5); // 1..5
  const forbidden: Array<[number, number]> = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rand() < 0.15) forbidden.push([x, y]);
    }
  }
  const nItems = 1 + Math.floor(rand() * 6); // 1..6
  const items = Array.from({ length: nItems }, (_, i) => ({
    id: String.fromCharCode(65 + i),
    w: 1 + Math.floor(rand() * 3),
    h: 1 + Math.floor(rand() * 3),
    profit: 1 + Math.floor(rand() * 12),
    rotate: rand() < 0.5,
  }));
  return { grid: { width, height, forbidden }, items };
}

test("solver matches exhaustive enumeration on 200 random small instances", () => {
  const rand = rng(20261005);
  for (let t = 0; t < 200; t++) {
    const inst = randomInstance(rand);
    const sol = solve(inst);
    const bf = bruteForceOptimum(inst);
    assert.equal(bf.exhausted, false, `case ${t}: budget exhausted`);
    assert.deepEqual(
      validateCertificate(inst, sol), [],
      `case ${t}: invalid certificate ${JSON.stringify(inst)}`,
    );
    assert.equal(sol.profit, bf.profit, `case ${t}: profit ${JSON.stringify(inst)}`);
    assert.equal(sol.area, bf.area, `case ${t}: area ${JSON.stringify(inst)}`);
  }
});

test("verifyInstance detects a tampered (suboptimal) certificate", () => {
  const inst: Instance = {
    grid: { width: 3, height: 2 },
    items: [
      { id: "A", w: 3, h: 2, profit: 10 },
      { id: "B", w: 1, h: 1, profit: 1 },
    ],
  };
  const bad = solve({
    grid: inst.grid,
    items: [inst.items[1]], // solve a different, weaker instance
  });
  const v = verifyInstance(inst, { ...bad, profit: 1, area: 1 });
  assert.equal(v.ok, false);
  assert.match(v.reason!, /mismatch/);
});

test("verifyInstance rejects certificates covering forbidden cells", () => {
  const inst: Instance = {
    grid: { width: 2, height: 2, forbidden: [[0, 0]] },
    items: [{ id: "A", w: 2, h: 2, profit: 5 }],
  };
  const sol = {
    profit: 5,
    area: 4,
    placements: [{ itemIndex: 0, id: "A", x: 0, y: 0, w: 2, h: 2, rotated: false, mask: 0n }],
  };
  const v = verifyInstance(inst, sol);
  assert.equal(v.ok, false);
  assert.match(v.reason!, /forbidden/);
});

test("verifyInstance confirms a known optimum", () => {
  const inst: Instance = {
    grid: { width: 4, height: 3, forbidden: [[1, 1]] },
    items: [
      { id: "A", w: 2, h: 2, profit: 8, rotate: true },
      { id: "B", w: 1, h: 3, profit: 5, rotate: true },
      { id: "C", w: 2, h: 1, profit: 3 },
    ],
  };
  const sol = solve(inst);
  const v = verifyInstance(inst, sol);
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.checked, true);
});
