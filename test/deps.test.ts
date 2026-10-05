import { test } from "node:test";
import assert from "node:assert/strict";
import { AvailabilityMonitor } from "../src/monitor.js";

test("因果链：依赖不可用则本服务虽在线也不算可用", () => {
  const m = new AvailabilityMonitor();
  m.addInterval("app", 0, 10);
  m.addInterval("db", 2, 8);
  m.addDependency("app", "db");
  // app 只有在 db 有效区间内才算可用
  assert.deepEqual(m.compute(1), [{ start: 2, end: 8, services: ["app", "db"] }]);
});

test("传递依赖：中间层失效会拖垮整条链", () => {
  const m = new AvailabilityMonitor();
  m.addInterval("web", 0, 10);
  m.addInterval("api", 0, 10);
  m.addInterval("db", 0, 10);
  m.addDependency("web", "api");
  m.addDependency("api", "db");
  m.removeInterval("api", 4, 6);
  assert.deepEqual(m.compute(1), [
    { start: 0, end: 4, services: ["api", "db", "web"] },
    { start: 4, end: 6, services: ["db"] },
    { start: 6, end: 10, services: ["api", "db", "web"] },
  ]);
});

test("循环依赖组件：只有全成员在线才计入", () => {
  const m = new AvailabilityMonitor();
  m.addInterval("x", 0, 10);
  m.addInterval("y", 3, 7);
  m.addDependency("x", "y");
  m.addDependency("y", "x");
  // x、y 互为依赖构成环：两者都要在线才都算可用
  assert.deepEqual(m.compute(1), [{ start: 3, end: 7, services: ["x", "y"] }]);
  assert.deepEqual(m.compute(2), [{ start: 3, end: 7, services: ["x", "y"] }]);
});

test("三节点环：任一成员缺口即整组不可用", () => {
  const m = new AvailabilityMonitor();
  m.addInterval("a", 0, 10);
  m.addInterval("b", 0, 10);
  m.addInterval("c", 0, 10);
  m.addDependency("a", "b");
  m.addDependency("b", "c");
  m.addDependency("c", "a");
  m.removeInterval("b", 4, 6);
  assert.deepEqual(m.compute(1), [
    { start: 0, end: 4, services: ["a", "b", "c"] },
    { start: 6, end: 10, services: ["a", "b", "c"] },
  ]);
});

test("环外依赖：环可用还要求环的外部依赖可用", () => {
  const m = new AvailabilityMonitor();
  m.addInterval("x", 0, 10);
  m.addInterval("y", 0, 10);
  m.addInterval("base", 5, 20);
  m.addDependency("x", "y");
  m.addDependency("y", "x");
  m.addDependency("x", "base");
  assert.deepEqual(m.compute(1), [
    { start: 5, end: 10, services: ["base", "x", "y"] },
    { start: 10, end: 20, services: ["base"] },
  ]);
});

test("增删依赖后重算：解依赖恢复独立可用性", () => {
  const m = new AvailabilityMonitor();
  m.addInterval("app", 0, 10);
  m.addInterval("db", 2, 8);
  m.addDependency("app", "db");
  assert.deepEqual(m.compute(1), [{ start: 2, end: 8, services: ["app", "db"] }]);
  m.removeDependency("app", "db");
  assert.deepEqual(m.compute(1), [
    { start: 0, end: 2, services: ["app"] },
    { start: 2, end: 8, services: ["app", "db"] },
    { start: 8, end: 10, services: ["app"] },
  ]);
});

test("菱形依赖：共享底层失效影响两个上层", () => {
  const m = new AvailabilityMonitor();
  m.addInterval("left", 0, 10);
  m.addInterval("right", 0, 10);
  m.addInterval("shared", 3, 7);
  m.addDependency("left", "shared");
  m.addDependency("right", "shared");
  assert.deepEqual(m.compute(2), [{ start: 3, end: 7, services: ["left", "right", "shared"] }]);
});
