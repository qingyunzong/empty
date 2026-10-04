import { test } from "node:test";
import * as assert from "node:assert/strict";
import { runEventLoop } from "../src/simulator.ts";
import type { LoopApi } from "../src/simulator.ts";
import { runQueueModel } from "../src/queueModel.ts";
import { traceEquals } from "../src/trace.ts";

/** mulberry32 确定性伪随机数发生器。 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MAX_TASKS = 80;

/**
 * 由种子生成一个确定性的随机程序：
 * 初始若干定时器/微任务，任务体随机派生新任务（总量封顶保证终止）。
 */
function makeSetup(seed: number): (api: LoopApi) => void {
  return (api) => {
    const rng = mulberry32(seed);
    let created = 0;
    let nextId = 0;

    const spawnRandom = (a: LoopApi): void => {
      if (created >= MAX_TASKS) return;
      created++;
      const id = `task-${nextId++}`;
      if (rng() < 0.5) {
        const delay = Math.floor(rng() * 6);
        a.setTimer(id, delay, (a2) => spawnChildren(a2));
      } else {
        a.queueMicrotask(id, (a2) => spawnChildren(a2));
      }
    };

    const spawnChildren = (a: LoopApi): void => {
      const children = Math.floor(rng() * 3);
      for (let i = 0; i < children; i++) spawnRandom(a);
    };

    const initial = 1 + Math.floor(rng() * 5);
    for (let i = 0; i < initial; i++) spawnRandom(api);
  };
}

test("随机程序：主模拟器与独立队列模型结果一致", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const setup = makeSetup(seed);
    const expected = runQueueModel(setup, 1000);
    const actual = runEventLoop(setup, { stepBudget: 1000 });
    assert.equal(actual.status, expected.status, `seed=${seed} status`);
    assert.ok(traceEquals(actual.trace, expected.trace), `seed=${seed} trace`);
  }
});

test("随机程序 + 小预算：未闭合状态与剩余任务数一致", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const budget = seed % 7;
    const setup = makeSetup(seed);
    const expected = runQueueModel(setup, budget);
    const actual = runEventLoop(setup, { stepBudget: budget });
    assert.equal(actual.status, expected.status, `seed=${seed} budget=${budget} status`);
    assert.ok(traceEquals(actual.trace, expected.trace), `seed=${seed} budget=${budget} trace`);
    if (actual.status === "exhausted") {
      assert.equal(actual.pending.timers, expected.pendingTimers, `seed=${seed} timers`);
      assert.equal(
        actual.pending.microtasks,
        expected.pendingMicrotasks,
        `seed=${seed} microtasks`,
      );
    }
  }
});
