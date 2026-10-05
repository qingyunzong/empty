import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  solve,
  verifyCertificate,
  bruteForceSolve,
  assignmentKey,
  ProblemInput,
} from "../src/index";
import { randomInput } from "./helpers";

test("手工算例：已知最优解", () => {
  // 两点间时间矩阵；车从 0 出发；两订单可串行衔接
  const input: ProblemInput = {
    points: 4,
    travelTime: [
      [0, 2, 5, 9],
      [2, 0, 3, 4],
      [5, 3, 0, 1],
      [9, 4, 1, 0],
    ],
    emptyCostPerUnitTime: 1,
    vehicles: [{ id: "V0", startPoint: 0, availableTime: 0 }],
    orders: [
      // O0: 0->1, 空驶0, 收益10, 净10
      { id: "O0", pickup: 0, delivery: 1, readyTime: 0, deadline: 100, serviceTime: 1, revenue: 10 },
      // O1: 2->3, 从 O0 送货点1空驶到2需3, 收益20, 净17
      { id: "O1", pickup: 2, delivery: 3, readyTime: 0, deadline: 100, serviceTime: 0, revenue: 20 },
    ],
  };
  const cert = solve(input);
  assert.equal(cert.objectiveValue, 27);
  assert.equal(cert.totalRevenue, 30);
  assert.equal(cert.totalEmptyTravelTime, 3);
  assert.deepEqual(cert.assignment, [0, 0]);
  assert.equal(cert.routes.length, 1);
  assert.deepEqual(cert.routes[0].stops.map((s) => s.orderId), ["O0", "O1"]);
  const v = verifyCertificate(input, cert);
  assert.ok(v.ok, v.errors.join("; "));
});

test("时间窗不可行的订单不分配", () => {
  const input: ProblemInput = {
    points: 2,
    travelTime: [
      [0, 5],
      [5, 0],
    ],
    emptyCostPerUnitTime: 1,
    vehicles: [{ id: "V0", startPoint: 0, availableTime: 0 }],
    orders: [
      // 送达时刻 = max(0+5, 0) + 0 + 5 = 10 > 9，不可行
      { id: "O0", pickup: 1, delivery: 0, readyTime: 0, deadline: 9, serviceTime: 0, revenue: 100 },
    ],
  };
  const cert = solve(input);
  assert.equal(cert.objectiveValue, 0);
  assert.deepEqual(cert.assignment, [-1]);
  assert.deepEqual(cert.unassigned, ["O0"]);
  assert.ok(verifyCertificate(input, cert).ok);
});

test("空驶费过高时不值得接单", () => {
  const input: ProblemInput = {
    points: 2,
    travelTime: [
      [0, 8],
      [8, 0],
    ],
    emptyCostPerUnitTime: 2,
    vehicles: [{ id: "V0", startPoint: 0, availableTime: 0 }],
    orders: [
      // 空驶8，空驶费16 > 收益10，不接
      { id: "O0", pickup: 1, delivery: 0, readyTime: 0, deadline: 100, serviceTime: 0, revenue: 10 },
    ],
  };
  const cert = solve(input);
  assert.equal(cert.objectiveValue, 0);
  assert.deepEqual(cert.assignment, [-1]);
});

test("并列时按订单分配序：全同车辆取小编号", () => {
  const mk = (): ProblemInput => ({
    points: 2,
    travelTime: [
      [0, 3],
      [3, 0],
    ],
    emptyCostPerUnitTime: 1,
    vehicles: [
      { id: "V0", startPoint: 0, availableTime: 0 },
      { id: "V1", startPoint: 0, availableTime: 0 },
    ],
    orders: [
      { id: "O0", pickup: 0, delivery: 1, readyTime: 0, deadline: 50, serviceTime: 0, revenue: 10 },
    ],
  });
  const cert = solve(mk());
  assert.equal(cert.objectiveValue, 10);
  assert.deepEqual(cert.assignment, [0]); // 两车等效，取车辆 0
});

test("并列时按订单分配序：跨订单字典序", () => {
  // 两订单两车，各车只能各接一单且收益相同，两种分法目标值并列，
  // 应取订单0分给车辆0的方案。
  const input: ProblemInput = {
    points: 3,
    travelTime: [
      [0, 1, 1],
      [1, 0, 1],
      [1, 1, 0],
    ],
    emptyCostPerUnitTime: 0,
    vehicles: [
      { id: "V0", startPoint: 0, availableTime: 0 },
      { id: "V1", startPoint: 1, availableTime: 0 },
    ],
    orders: [
      // O0 只能由 V0 之后的时刻... 构造：O0 取货点0，O1 取货点1，
      // 两车各接一单都可行；若一车接两单则赶不上截止时间。
      { id: "O0", pickup: 0, delivery: 2, readyTime: 0, deadline: 2, serviceTime: 0, revenue: 10 },
      { id: "O1", pickup: 1, delivery: 2, readyTime: 0, deadline: 2, serviceTime: 0, revenue: 10 },
    ],
  };
  const cert = solve(input);
  assert.equal(cert.objectiveValue, 20);
  assert.deepEqual(cert.assignment, [0, 1]);
  assert.ok(verifyCertificate(input, cert).ok);
});

test("assignmentKey 编码符合并列规则", () => {
  // V=2，基3；[0,1] < [0,-1] < [1,0]
  const k01 = assignmentKey([0, 1], 2);
  const k0u = assignmentKey([0, -1], 2);
  const k10 = assignmentKey([1, 0], 2);
  assert.ok(k01 < k0u);
  assert.ok(k0u < k10);
});

test("证书核对能发现篡改", () => {
  const input = randomInput(12345, 5, 2);
  const cert = solve(input);
  assert.ok(verifyCertificate(input, cert).ok);
  const tampered = JSON.parse(JSON.stringify(cert)) as typeof cert;
  tampered.objectiveValue += 1;
  const r = verifyCertificate(input, tampered);
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
});

test("随机小规模：求解器与独立枚举完全一致", () => {
  const cases = 60;
  for (let c = 0; c < cases; c++) {
    const n = 1 + (c % 8); // 1..8 单
    const V = 1 + (c % 3); // 1..3 车
    const input = randomInput(1000 + c * 7919, n, V);
    const cert = solve(input);
    const brute = bruteForceSolve(input);
    assert.equal(
      cert.objectiveValue,
      brute.objectiveValue,
      `case ${c} (n=${n},V=${V}) 目标值不一致`,
    );
    assert.deepEqual(
      cert.assignment,
      brute.assignment,
      `case ${c} (n=${n},V=${V}) 分配序列不一致`,
    );
    const v = verifyCertificate(input, cert);
    assert.ok(v.ok, `case ${c} 证书核对失败: ${v.errors.join("; ")}`);
  }
});

test("规模上限：14 订单多车可解且证书有效", () => {
  const input = randomInput(20261005, 14, 3);
  const t0 = Date.now();
  const cert = solve(input);
  const elapsed = Date.now() - t0;
  const v = verifyCertificate(input, cert);
  assert.ok(v.ok, v.errors.join("; "));
  assert.ok(elapsed < 30000, `求解耗时 ${elapsed}ms 超限`);
  console.log(`14 订单 3 车求解耗时 ${elapsed}ms，目标值 ${cert.objectiveValue}`);
});
