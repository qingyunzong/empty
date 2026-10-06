import assert from "node:assert/strict";
import test from "node:test";
import {
  bruteForceSchedule,
  solveSchedule,
} from "../src/schedule.js";
import type { ScheduleInput } from "../src/types.js";
import { validateSchedule } from "../src/validate.js";
import { mulberry32, randInt } from "./helpers.js";

test("手工算例：容量足够时零缺货", () => {
  const input: ScheduleInput = {
    quantities: [10, 20],
    slots: [
      { capacity: 30, demand: 10 },
      { capacity: 30, demand: 20 },
    ],
  };
  const res = solveSchedule(input);
  assert.equal(res.feasible, true);
  assert.equal(res.totalShortage, 0);
  assert.deepEqual(res.assignment, [0, 0]);
  assert.equal(res.slots[0]?.load, 30);
  assert.equal(res.slots[1]?.shortage, 0);
});

test("逐时段缺货验证：前期不足产生缺货，后期到货不回补", () => {
  const input: ScheduleInput = {
    quantities: [10],
    slots: [
      { capacity: 10, demand: 8 },
      { capacity: 10, demand: 5 },
    ],
  };
  const res = solveSchedule(input);
  assert.equal(res.feasible, true);
  assert.deepEqual(res.assignment, [0]);
  assert.equal(res.slots[0]?.shortage, 0);
  assert.equal(res.slots[1]?.shortage, 3);
  assert.equal(res.totalShortage, 3);
});

test("缺货不可避免时取最小总缺货", () => {
  const input: ScheduleInput = {
    quantities: [5, 5],
    slots: [
      { capacity: 5, demand: 8 },
      { capacity: 5, demand: 8 },
    ],
  };
  const res = solveSchedule(input);
  assert.equal(res.feasible, true);
  assert.equal(res.totalShortage, 9);
  assert.equal(res.slots[0]?.shortage, 3);
  assert.equal(res.slots[1]?.shortage, 6);
});

test("容量装不下全部订单则不可行", () => {
  const input: ScheduleInput = {
    quantities: [10, 10],
    slots: [{ capacity: 15, demand: 0 }],
  };
  const res = solveSchedule(input);
  assert.equal(res.feasible, false);
  const brute = bruteForceSchedule(input);
  assert.equal(brute.feasible, false);
});

test("平局时偏向更早时段（按供应商序字典序）", () => {
  const input: ScheduleInput = {
    quantities: [4, 6],
    slots: [
      { capacity: 10, demand: 0 },
      { capacity: 10, demand: 0 },
    ],
  };
  const res = solveSchedule(input);
  assert.equal(res.feasible, true);
  assert.deepEqual(res.assignment, [0, 0]);
});

test("输入校验：拒绝非法排程配置", () => {
  assert.throws(() =>
    validateSchedule({ quantities: [1], slots: [] }),
  );
  assert.throws(() =>
    validateSchedule({ quantities: [81], slots: [{ capacity: 1, demand: 0 }] }),
  );
  assert.throws(() =>
    validateSchedule({ quantities: [1.5], slots: [{ capacity: 1, demand: 0 }] }),
  );
});

function randomSchedule(rng: () => number): ScheduleInput {
  const n = randInt(rng, 1, 4);
  const slotCount = randInt(rng, 1, 4);
  const quantities = Array.from({ length: n }, () => randInt(rng, 0, 6));
  const slots = Array.from({ length: slotCount }, () => ({
    capacity: randInt(rng, 0, 10),
    demand: randInt(rng, 0, 8),
  }));
  return { quantities, slots };
}

test("随机小例：联合DP 与穷举完全一致（300 组）", () => {
  const rng = mulberry32(20261006);
  for (let iter = 0; iter < 300; iter++) {
    const input = randomSchedule(rng);
    validateSchedule(input);
    const dp = solveSchedule(input);
    const brute = bruteForceSchedule(input);
    assert.equal(dp.feasible, brute.feasible, `iter=${iter} input=${JSON.stringify(input)}`);
    assert.equal(dp.totalShortage, brute.totalShortage, `iter=${iter}`);
    assert.deepEqual(dp.assignment, brute.assignment, `iter=${iter}`);
    if (dp.feasible) {
      for (const slot of dp.slots) {
        assert.ok(slot.load <= slot.capacity, `iter=${iter} 容量越界`);
        const expected = Math.max(0, slot.cumDemand - slot.cumArrival);
        assert.equal(slot.shortage, expected, `iter=${iter} 缺货口径`);
      }
    }
  }
});
