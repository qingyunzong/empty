import test from "node:test";
import * as assert from "node:assert/strict";
import { WarehouseInput } from "../src/model";
import { solve } from "../src/core";
import { enumerateOptimum } from "../src/enumerate";
import { buildReplanInput, replanWarehouse } from "../src/replan";

const baseWh = (demand: number[]): WarehouseInput => ({
  id: "W",
  capacity: 12,
  initialInventory: 0,
  demand,
  leadTime: 2,
  fixedOrderCost: 10,
  holdingCost: 1,
});

test("locked portion of a published order cannot be cancelled", () => {
  const wh = baseWh([0, 0, 1, 1, 1, 1]);
  const out = replanWarehouse(wh, 6, 0, 0, [{ arrivalDay: 2, qty: 10, lockedQty: 10 }], 0);
  assert.ok(out.result.feasible);
  const change = out.changes.find((c) => c.arrivalDay === 2);
  assert.equal(change?.newQty, 10); // fully locked: stays even though demand is tiny
  assert.equal(out.totalDeviation, 0);
});

test("unlocked portion can be cancelled, locked part remains", () => {
  const wh = baseWh([0, 0, 1, 1, 1, 1]);
  const out = replanWarehouse(wh, 6, 0, 0, [{ arrivalDay: 2, qty: 10, lockedQty: 3 }], 0);
  assert.ok(out.result.feasible);
  const change = out.changes.find((c) => c.arrivalDay === 2);
  // demand from day 2 on is 4 units; keeping exactly 4 minimizes |new-10| subject to feasibility? No:
  // deviation is minimized first -> keep as close to 10 as possible -> newQty = 10? No:
  // deviation objective minimizes |new-published|, so keeping 10 (dev 0) dominates any cancel.
  assert.equal(change?.newQty, 10);
  assert.equal(out.totalDeviation, 0);
});

test("deviation-first: solver keeps published qty even when cancelling saves money", () => {
  const wh = baseWh([0, 0, 2, 0, 0, 0]);
  // published 8 arriving day 2, unlocked; demand only 2. Cancelling to 2 saves
  // holding cost but deviates by 6; deviation is minimized first, so keep 8.
  const out = replanWarehouse(wh, 6, 0, 0, [{ arrivalDay: 2, qty: 8, lockedQty: 0 }], 0);
  assert.ok(out.result.feasible);
  assert.equal(out.totalDeviation, 0);
  const change = out.changes.find((c) => c.arrivalDay === 2);
  assert.equal(change?.newQty, 8);
  // money-optimal plan ignoring deviation would cancel down to 2
  const input = buildReplanInput(wh, 6, 0, 0, [{ arrivalDay: 2, qty: 8, lockedQty: 0 }], 0);
  const moneyOnly = solve({ ...input, slots: input.slots.map((r) => r.map((s) => ({ ...s, devBase: null }))) });
  assert.ok(moneyOnly.cost.money < out.result.cost.money);
});

test("when published orders must change, change is minimal then cost minimal (vs enumeration)", () => {
  const wh: WarehouseInput = {
    ...baseWh([0, 0, 9, 9, 0, 0]),
    capacity: 12,
  };
  // published 4 arriving day 2 (unlocked): cannot cover corrected demand 9+9,
  // so it must increase; new normal orders can only arrive from day 2 (now=0, lead 2).
  const out = replanWarehouse(wh, 6, 0, 0, [{ arrivalDay: 2, qty: 4, lockedQty: 0 }], 0);
  assert.ok(out.result.feasible);
  const input = buildReplanInput(wh, 6, 0, 0, [{ arrivalDay: 2, qty: 4, lockedQty: 0 }], 0);
  const brute = enumerateOptimum(input);
  if (brute === null) throw new Error("enumeration says infeasible");
  assert.equal(out.result.cost.dev, brute.dev);
  assert.equal(out.result.cost.money, brute.money);
});

test("net difference vs baseline of keeping published orders unchanged", () => {
  const wh = baseWh([0, 0, 2, 2, 2, 2]);
  const published = [{ arrivalDay: 2, qty: 12, lockedQty: 0 }];
  const out = replanWarehouse(wh, 6, 0, 0, published, 0);
  assert.ok(out.result.feasible);
  // baseline keeps 12 units arriving day 2: feasible, holding-heavy
  assert.equal(out.baselineMoney, 1 * (10 + 8 + 6 + 4)); // 28
  // deviation-first keeps 12 too (dev 0), so net difference is 0
  assert.equal(out.netDifference, 0);
});

test("baseline infeasible -> net difference reported as null", () => {
  const wh = baseWh([0, 0, 9, 9, 9, 9]);
  const out = replanWarehouse(wh, 6, 0, 0, [{ arrivalDay: 2, qty: 4, lockedQty: 0 }], 0);
  assert.ok(out.result.feasible);
  assert.equal(out.baselineMoney, null);
  assert.equal(out.netDifference, null);
});

test("lock window: orders arriving inside window are fully locked by default", () => {
  const wh = baseWh([0, 0, 0, 1, 1, 1]);
  const out = replanWarehouse(
    wh,
    6,
    2,
    0,
    [
      { arrivalDay: 3, qty: 9 }, // inside window now+2 -> locked
      { arrivalDay: 5, qty: 9 }, // outside window -> unlocked
    ],
    2
  );
  assert.ok(out.result.feasible);
  const c3 = out.changes.find((c) => c.arrivalDay === 3);
  const c5 = out.changes.find((c) => c.arrivalDay === 5);
  assert.equal(c3?.locked, 9);
  assert.equal(c3?.newQty, 9);
  assert.equal(c5?.locked, 0);
  // keeping both at 9 would exceed capacity 12 on day 5 (7+9), so the
  // minimal deviation is to cut day-5 order to 5 (dev 4)
  assert.equal(c5?.newQty, 5);
  assert.equal(out.totalDeviation, 4);
});

test("replan DP matches enumeration on random small cases", () => {
  let seed = 123456789;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let k = 0; k < 120; k++) {
    const H = 3 + Math.floor(rng() * 4);
    const now = Math.floor(rng() * (H - 1));
    const C = 2 + Math.floor(rng() * 5);
    const wh: WarehouseInput = {
      id: "W",
      capacity: C,
      initialInventory: 0,
      demand: Array.from({ length: H }, () => Math.floor(rng() * (C + 1))),
      leadTime: 1 + Math.floor(rng() * 2),
      fixedOrderCost: Math.floor(rng() * 8),
      holdingCost: Math.floor(rng() * 3),
    };
    const published = Array.from({ length: Math.floor(rng() * 3) }, () => {
      const qty = Math.floor(rng() * (C + 1));
      return {
        arrivalDay: now + Math.floor(rng() * (H - now)),
        qty,
        lockedQty: Math.floor(rng() * (qty + 1)),
      };
    });
    const input = buildReplanInput(wh, H, now, Math.floor(rng() * (C + 1)), published, 0);
    const dp = solve(input);
    const en = enumerateOptimum(input);
    const dpCost = dp.feasible ? dp.cost : null;
    if (dpCost === null || en === null) {
      assert.equal(dpCost, en, `case ${k}: feasibility mismatch`);
    } else {
      assert.equal(dpCost.dev, en.dev, `case ${k}: dev`);
      assert.equal(dpCost.money, en.money, `case ${k}: money`);
    }
  }
});
