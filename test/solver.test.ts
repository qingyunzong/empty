import { test } from "node:test";
import assert from "node:assert/strict";
import { solvePlan, verifyCertificate, MAX_ORDERS } from "../src/index.js";
import type { PlanInput } from "../src/index.js";
import { mulberry32, randomInstance } from "./helpers.js";

// 1 辆车在地点 0，订单 A(地点1)、B(地点2)。空驶 0->1=3, 1->2=4, 0->2=8（对称矩阵）。
const baseMatrix = [
  [0, 3, 8],
  [3, 0, 4],
  [8, 4, 0],
];

test("时间衔接含空驶：顺序由空驶时间决定，等待不计费", () => {
  const input: PlanInput = {
    orders: [
      { id: "A", location: 1, readyTime: 0, dueTime: 100, duration: 2, revenue: 10 },
      { id: "B", location: 2, readyTime: 5, dueTime: 100, duration: 1, revenue: 10 },
    ],
    vehicles: [{ id: "v0", startLocation: 0, availableTime: 0, costPerUnitTime: 1 }],
    emptyTime: baseMatrix,
  };
  const cert = solvePlan(input);
  // A->B：空驶 3+4=7，利润 20-7=13；B->A：空驶 8+4=12，利润 8。选 A->B。
  assert.equal(cert.profit, 13);
  assert.equal(cert.totalRevenue, 20);
  assert.equal(cert.totalEmptyCost, 7);
  assert.deepStrictEqual(cert.assignment, [0, 0]);
  const stops = cert.routes[0].stops;
  assert.deepStrictEqual(stops.map((s) => s.orderId), ["A", "B"]);
  // A: 到达 3，开始 3，完成 5；B: 到达 5+4=9，开始 9，完成 10。
  assert.deepStrictEqual(
    stops.map((s) => [s.emptyTimeFromPrev, s.arrivalTime, s.startTime, s.completionTime]),
    [
      [3, 3, 3, 5],
      [4, 9, 9, 10],
    ],
  );
  assert.deepStrictEqual(verifyCertificate(input, cert), []);
});

test("等待不计空驶费：到达早于 readyTime 只等待", () => {
  const input: PlanInput = {
    orders: [{ id: "A", location: 1, readyTime: 10, dueTime: 20, duration: 1, revenue: 100 }],
    vehicles: [{ id: "v0", startLocation: 0, availableTime: 0, costPerUnitTime: 1 }],
    emptyTime: baseMatrix,
  };
  const cert = solvePlan(input);
  assert.equal(cert.profit, 97); // 100 - 3，等待 7 不计费
  assert.equal(cert.routes[0].stops[0].arrivalTime, 3);
  assert.equal(cert.routes[0].stops[0].startTime, 10);
  assert.deepStrictEqual(verifyCertificate(input, cert), []);
});

test("dueTime 过紧导致订单无法衔接/服务，被放弃", () => {
  const input: PlanInput = {
    orders: [
      { id: "A", location: 1, readyTime: 0, dueTime: 100, duration: 2, revenue: 10 },
      { id: "B", location: 2, readyTime: 5, dueTime: 6, duration: 1, revenue: 10 },
    ],
    vehicles: [{ id: "v0", startLocation: 0, availableTime: 0, costPerUnitTime: 1 }],
    emptyTime: baseMatrix,
  };
  const cert = solvePlan(input);
  // B 单独服务到达 8 > 6，A->B 到达 9 > 6，均不可行 => B 放弃。
  assert.equal(cert.profit, 7); // 10 - 3
  assert.deepStrictEqual(cert.assignment, [0, null]);
  assert.deepStrictEqual(verifyCertificate(input, cert), []);
});

test("并列按订单分配序：相同车辆时订单分给下标小的车", () => {
  const input: PlanInput = {
    orders: [{ id: "A", location: 1, readyTime: 0, dueTime: 10, duration: 1, revenue: 5 }],
    vehicles: [
      { id: "v0", startLocation: 0, availableTime: 0, costPerUnitTime: 1 },
      { id: "v1", startLocation: 0, availableTime: 0, costPerUnitTime: 1 },
    ],
    emptyTime: baseMatrix,
  };
  const cert = solvePlan(input);
  assert.equal(cert.profit, 2); // 5 - 3
  assert.deepStrictEqual(cert.assignment, [0]); // 而非 [1]
  assert.deepStrictEqual(verifyCertificate(input, cert), []);
});

test("并列按订单分配序：零利润订单已分配优于未分配", () => {
  const input: PlanInput = {
    orders: [{ id: "A", location: 1, readyTime: 0, dueTime: 10, duration: 1, revenue: 3 }],
    vehicles: [{ id: "v0", startLocation: 0, availableTime: 0, costPerUnitTime: 1 }],
    emptyTime: baseMatrix,
  };
  const cert = solvePlan(input);
  assert.equal(cert.profit, 0); // 3 - 3
  assert.deepStrictEqual(cert.assignment, [0]); // 而非 [null]
  assert.deepStrictEqual(verifyCertificate(input, cert), []);
});

test("负利润订单不分配", () => {
  const input: PlanInput = {
    orders: [{ id: "A", location: 1, readyTime: 0, dueTime: 10, duration: 1, revenue: 2 }],
    vehicles: [{ id: "v0", startLocation: 0, availableTime: 0, costPerUnitTime: 1 }],
    emptyTime: baseMatrix,
  };
  const cert = solvePlan(input);
  assert.equal(cert.profit, 0);
  assert.deepStrictEqual(cert.assignment, [null]);
  assert.deepStrictEqual(verifyCertificate(input, cert), []);
});

test("空订单列表：利润 0，路线为空", () => {
  const input: PlanInput = {
    orders: [],
    vehicles: [{ id: "v0", startLocation: 0, availableTime: 0, costPerUnitTime: 1 }],
    emptyTime: baseMatrix,
  };
  const cert = solvePlan(input);
  assert.equal(cert.profit, 0);
  assert.deepStrictEqual(cert.assignment, []);
  assert.equal(cert.routes.length, 1);
  assert.equal(cert.routes[0].stops.length, 0);
  assert.deepStrictEqual(verifyCertificate(input, cert), []);
});

test("每单至多一车：两车争抢同一高收益单", () => {
  const input: PlanInput = {
    orders: [{ id: "A", location: 1, readyTime: 0, dueTime: 10, duration: 1, revenue: 100 }],
    vehicles: [
      { id: "v0", startLocation: 0, availableTime: 0, costPerUnitTime: 1 },
      { id: "v1", startLocation: 2, availableTime: 0, costPerUnitTime: 1 },
    ],
    emptyTime: baseMatrix,
  };
  const cert = solvePlan(input);
  // v0 空驶 3，v1 空驶 4，选 v0。
  assert.equal(cert.profit, 97);
  assert.deepStrictEqual(cert.assignment, [0]);
  const served = cert.routes.reduce((acc, r) => acc + r.stops.length, 0);
  assert.equal(served, 1);
  assert.deepStrictEqual(verifyCertificate(input, cert), []);
});

test("多车分工：利润最大化跨车分配", () => {
  const input: PlanInput = {
    orders: [
      { id: "A", location: 1, readyTime: 0, dueTime: 100, duration: 2, revenue: 10 },
      { id: "B", location: 2, readyTime: 5, dueTime: 100, duration: 1, revenue: 10 },
    ],
    vehicles: [
      { id: "v0", startLocation: 0, availableTime: 0, costPerUnitTime: 1 },
      { id: "v1", startLocation: 0, availableTime: 0, costPerUnitTime: 1 },
    ],
    emptyTime: baseMatrix,
  };
  const cert = solvePlan(input);
  // 一车全做：20-7=13；分两车：(10-3)+(10-8)=9。选一车全做。
  assert.equal(cert.profit, 13);
  assert.deepStrictEqual(cert.assignment, [0, 0]);
  assert.deepStrictEqual(verifyCertificate(input, cert), []);
});

test("超过 14 单抛 RangeError", () => {
  const orders = Array.from({ length: MAX_ORDERS + 1 }, (_, i) => ({
    id: `o${i}`,
    location: 0,
    readyTime: 0,
    dueTime: 10,
    duration: 1,
    revenue: 1,
  }));
  const input: PlanInput = {
    orders,
    vehicles: [{ id: "v0", startLocation: 0, availableTime: 0, costPerUnitTime: 1 }],
    emptyTime: [[0]],
  };
  assert.throws(() => solvePlan(input), RangeError);
});

test("14 单 2 车冒烟测试：结果可行且账目一致", () => {
  const rand = mulberry32(20261006);
  const input = randomInstance(rand, 14, 2);
  const t0 = Date.now();
  const cert = solvePlan(input);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 60_000, `solver too slow: ${elapsed}ms`);
  assert.deepStrictEqual(verifyCertificate(input, cert), []);
  assert.ok(cert.profit >= 0);
  console.log(`  14 单 2 车求解耗时 ${elapsed}ms，利润 ${cert.profit}`);
});
