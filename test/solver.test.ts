import test from "node:test";
import * as assert from "node:assert/strict";
import { SolveInput, solve, simulate, Cost } from "../src/core";
import { finiteStateSearch } from "../src/finitestate";
import { enumerateOptimum } from "../src/enumerate";
import { buildCertificate, checkCertificate } from "../src/certificate";
import { buildPlanInput } from "../src/plan";
import { parseScenario } from "../src/model";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function costEq(a: Cost | null, b: Cost | null): boolean {
  if (a === null || b === null) return a === b;
  return a.dev === b.dev && a.money === b.money;
}

test("hand-computed optimum: single order covering two days beats two orders", () => {
  const input: SolveInput = {
    capacity: 10,
    initialInventory: 2,
    demand: [2, 3, 2],
    holdingCost: 1,
    streams: [{ name: "normal", lead: 1, fixedCost: 5, unitCost: 0 }],
    slots: [
      [{ min: 0, max: 0, counted: false, devBase: null }],
      [{ min: 0, max: 10, counted: true, devBase: null }],
      [{ min: 0, max: 10, counted: true, devBase: null }],
    ],
  };
  const res = solve(input);
  assert.ok(res.feasible);
  // one order of 5 arriving day 1: fixed 5 + holding 2 = 7
  assert.equal(res.cost.money, 7);
  assert.deepEqual(res.decisions.map((d) => d.qty[0]), [0, 5, 0]);
});

test("expedited stream is used when normal lead time is too long", () => {
  const input: SolveInput = {
    capacity: 10,
    initialInventory: 0,
    demand: [0, 2, 0],
    holdingCost: 1,
    streams: [
      { name: "normal", lead: 3, fixedCost: 5, unitCost: 0 },
      { name: "expedited", lead: 1, fixedCost: 8, unitCost: 0 },
    ],
    slots: [
      [{ min: 0, max: 0, counted: false, devBase: null }, { min: 0, max: 0, counted: false, devBase: null }],
      [{ min: 0, max: 0, counted: false, devBase: null }, { min: 0, max: 10, counted: true, devBase: null }],
      [{ min: 0, max: 0, counted: false, devBase: null }, { min: 0, max: 10, counted: true, devBase: null }],
    ],
  };
  const res = solve(input);
  assert.ok(res.feasible);
  assert.equal(res.cost.money, 8);
  assert.equal(res.decisions[1].qty[1], 2);
});

test("infeasible when demand exceeds capacity plus inventory", () => {
  const input: SolveInput = {
    capacity: 3,
    initialInventory: 1,
    demand: [5],
    holdingCost: 1,
    streams: [{ name: "normal", lead: 0, fixedCost: 5, unitCost: 0 }],
    slots: [[{ min: 0, max: 3, counted: true, devBase: null }]],
  };
  assert.equal(solve(input).feasible, false);
  assert.equal(finiteStateSearch(input), null);
  assert.equal(enumerateOptimum(input), null);
});

function randomInput(rng: () => number): SolveInput {
  const ri = (n: number) => Math.floor(rng() * (n + 1));
  const T = 1 + ri(4);
  const C = 1 + ri(6);
  const normalLead = ri(3);
  const streams = [{ name: "normal", lead: normalLead, fixedCost: ri(8), unitCost: ri(2) }];
  const useExp = normalLead > 0 && rng() < 0.5;
  if (useExp) {
    streams.push({
      name: "expedited",
      lead: ri(normalLead - 1),
      fixedCost: ri(12),
      unitCost: ri(3),
    });
  }
  const demand = Array.from({ length: T }, () => ri(C));
  const slots = Array.from({ length: T }, (_, t) =>
    streams.map((s) => {
      if (t < s.lead) {
        const committed = rng() < 0.3 ? ri(2) : 0;
        return { min: committed, max: committed, counted: false, devBase: null };
      }
      const kind = rng();
      if (kind < 0.25) {
        // published order: sunk cost, deviation tracked, partially locked
        const pub = ri(Math.min(4, C));
        const locked = ri(pub);
        return { min: locked, max: C, counted: false, devBase: pub };
      }
      return { min: 0, max: C, counted: true, devBase: null };
    })
  );
  return {
    capacity: C,
    initialInventory: ri(C),
    demand,
    holdingCost: ri(3),
    streams,
    slots,
  };
}

test("DP agrees with independent finite-state search and enumeration (300 random cases)", () => {
  const rng = mulberry32(20261005);
  let feasibleCount = 0;
  for (let k = 0; k < 300; k++) {
    const input = randomInput(rng);
    const dp = solve(input);
    const fs = finiteStateSearch(input);
    const dpCost = dp.feasible ? dp.cost : null;
    assert.ok(costEq(dpCost, fs ? fs.cost : null), `case ${k}: dp vs finite-state`);
    let en: Cost | null | undefined;
    try {
      en = enumerateOptimum(input);
    } catch {
      en = undefined; // space too large: enumeration cross-check not applicable
    }
    if (en !== undefined) assert.ok(costEq(dpCost, en), `case ${k}: dp vs enumeration`);
    if (dp.feasible) {
      feasibleCount++;
      // DP decisions must be feasible and achieve the reported cost
      const rows = simulate(input, dp.decisions);
      if (rows === null) throw new Error(`case ${k}: decisions do not simulate`);
      const money = rows.reduce((a, r) => a + r.money, 0);
      const dev = rows.reduce((a, r) => a + r.dev, 0);
      assert.equal(money, dp.cost.money, `case ${k}: simulated money`);
      assert.equal(dev, dp.cost.dev, `case ${k}: simulated dev`);
      // certificate conservation
      const cert = buildCertificate(input, dp.decisions, 0);
      assert.deepEqual(checkCertificate(cert, input.capacity), [], `case ${k}: conservation`);
    }
  }
  assert.ok(feasibleCount > 100, `expected many feasible cases, got ${feasibleCount}`);
});

test("scenario validation: horizon capped at 12 days, integers required", () => {
  assert.throws(() =>
    parseScenario({ horizon: 13, warehouses: [{ capacity: 1, initialInventory: 0, demand: [], leadTime: 0, fixedOrderCost: 0, holdingCost: 0 }] })
  );
  assert.throws(() =>
    parseScenario({ horizon: 2, warehouses: [{ capacity: 1, initialInventory: 0, demand: [1, 1.5], leadTime: 0, fixedOrderCost: 0, holdingCost: 0 }] })
  );
  const ok = parseScenario({
    horizon: 2,
    warehouses: [{ capacity: 4, initialInventory: 1, demand: [1, 2], leadTime: 1, fixedOrderCost: 3, holdingCost: 1 }],
  });
  const res = solve(buildPlanInput(ok.warehouses[0], ok.horizon));
  assert.ok(res.feasible);
});
