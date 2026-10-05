import { test } from "node:test";
import assert from "node:assert/strict";
import { AvailabilityMonitor } from "../src/monitor.js";

test("半开端点：k=1 时相邻区间首尾相接不重叠不留缝", () => {
  const m = new AvailabilityMonitor();
  m.addInterval("a", 0, 5);
  m.addInterval("b", 5, 10);
  assert.deepEqual(m.compute(1), [
    { start: 0, end: 5, services: ["a"] },
    { start: 5, end: 10, services: ["b"] },
  ]);
  // k=2 时在拼接点 5 处两边都只有 1 个服务，结果为空
  assert.deepEqual(m.compute(2), []);
});

test("同点先统一增减再判定：一点同时一增一减，计数连续", () => {
  const m = new AvailabilityMonitor();
  m.addInterval("a", 0, 5);
  m.addInterval("b", 3, 5);
  m.addInterval("c", 5, 8);
  m.addInterval("d", 5, 9);
  // t=5 处 a、b 同时下线，c、d 同时上线；k=2 在 5 前后都满足，
  // 但支持集合不同，应分为两段，且 [5,8) 段绝不能出现计数掉落的缝隙。
  assert.deepEqual(m.compute(2), [
    { start: 3, end: 5, services: ["a", "b"] },
    { start: 5, end: 8, services: ["c", "d"] },
  ]);
});

test("支持集合相同的相邻段合并为最大区间", () => {
  const m = new AvailabilityMonitor();
  m.addInterval("a", 0, 4);
  m.addInterval("a", 4, 10); // 同服务相邻区间先规范化合并
  m.addInterval("b", 2, 8);
  assert.deepEqual(m.compute(2), [{ start: 2, end: 8, services: ["a", "b"] }]);
  assert.deepEqual(m.compute(1), [
    { start: 0, end: 2, services: ["a"] },
    { start: 2, end: 8, services: ["a", "b"] },
    { start: 8, end: 10, services: ["a"] },
  ]);
});

test("k=1 时支持集合变化会切段，计数不中断", () => {
  const m = new AvailabilityMonitor();
  m.addInterval("a", 0, 10);
  m.addInterval("b", 3, 6);
  assert.deepEqual(m.compute(1), [
    { start: 0, end: 3, services: ["a"] },
    { start: 3, end: 6, services: ["a", "b"] },
    { start: 6, end: 10, services: ["a"] },
  ]);
});

test("删除区间可切分段并更新支持集合", () => {
  const m = new AvailabilityMonitor();
  m.addInterval("a", 0, 10);
  m.addInterval("b", 0, 10);
  m.removeInterval("b", 4, 6);
  assert.deepEqual(m.compute(2), [
    { start: 0, end: 4, services: ["a", "b"] },
    { start: 6, end: 10, services: ["a", "b"] },
  ]);
  assert.deepEqual(m.compute(1), [
    { start: 0, end: 4, services: ["a", "b"] },
    { start: 4, end: 6, services: ["a"] },
    { start: 6, end: 10, services: ["a", "b"] },
  ]);
});

test("非法区间与非法 k 被拒绝", () => {
  const m = new AvailabilityMonitor();
  assert.throws(() => m.addInterval("a", 5, 5));
  assert.throws(() => m.addInterval("a", 7, 3));
  assert.throws(() => m.compute(0));
});
