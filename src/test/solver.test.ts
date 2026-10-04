import { test } from "node:test";
import * as assert from "node:assert/strict";
import { compileInstance } from "../instance.js";
import { solve } from "../solver.js";
import { solveBrute } from "../brute.js";
import { buildCertificate, verifyCertificate } from "../certificate.js";
import { simulateRoute } from "../route.js";
import type { InstanceSpec } from "../types.js";

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

function randomSpec(rng: () => number, n: number, timeLimit = 60): InstanceSpec {
  const stations = [];
  for (let i = 0; i < n; i++) {
    const open = Math.floor(rng() * 20);
    const width = 10 + Math.floor(rng() * 40);
    stations.push({
      id: `R${i}`,
      x: Math.round(rng() * 50 - 25),
      y: Math.round(rng() * 50 - 25),
      service: 1 + Math.floor(rng() * 5),
      open,
      close: open + width,
      profit: 1 + Math.floor(rng() * 10),
    });
  }
  return { name: `rand-${n}`, timeLimit, depot: { x: 0, y: 0 }, stations };
}

test("手工小例：远站被时限排除，只访问近站", () => {
  const inst = compileInstance({
    timeLimit: 60,
    depot: { x: 0, y: 0 },
    stations: [
      { id: "A", x: 3, y: 4, service: 0, open: 0, close: 100, profit: 10 },
      { id: "B", x: 30, y: 40, service: 0, open: 0, close: 100, profit: 11 },
    ],
  });
  const res = solve(inst);
  assert.equal(res.profit, 10);
  assert.equal(res.distance, 10);
  assert.deepEqual(res.route, [1]);
});

test("并列收益时选路程更小的方案", () => {
  const inst = compileInstance({
    timeLimit: 60,
    depot: { x: 0, y: 0 },
    stations: [
      { id: "NEAR", x: 3, y: 4, service: 0, open: 0, close: 100, profit: 5 },
      { id: "FAR", x: 30, y: 0, service: 0, open: 0, close: 100, profit: 5 },
    ],
  });
  const res = solve(inst);
  assert.equal(res.profit, 5);
  assert.equal(res.distance, 10);
  assert.deepEqual(res.route, [1]);
});

test("时间窗等待计入总耗时", () => {
  const inst = compileInstance({
    timeLimit: 60,
    depot: { x: 0, y: 0 },
    stations: [{ id: "W", x: 3, y: 4, service: 5, open: 10, close: 20, profit: 5 }],
  });
  const res = solve(inst);
  assert.equal(res.profit, 5);
  const cert = buildCertificate(inst, res);
  const leg = cert.legs[1]!;
  assert.equal(leg.arrive, 5);
  assert.equal(leg.wait, 5);
  assert.equal(leg.start, 10);
  assert.equal(leg.depart, 15);
  assert.equal(cert.totalTime, 20);
});

test("到达晚于 close 的站点不可服务", () => {
  const inst = compileInstance({
    timeLimit: 60,
    depot: { x: 0, y: 0 },
    stations: [{ id: "LATE", x: 30, y: 0, service: 1, open: 0, close: 10, profit: 100 }],
  });
  const res = solve(inst);
  assert.equal(res.profit, 0);
  assert.deepEqual(res.route, []);
});

test("小图穷举验证：40 个随机实例 DP 与穷举一致", () => {
  const rng = mulberry32(20261005);
  for (let k = 0; k < 40; k++) {
    const n = 4 + Math.floor(rng() * 5); // 4..8 站
    const inst = compileInstance(randomSpec(rng, n));
    const fast = solve(inst);
    const brute = solveBrute(inst);
    assert.equal(fast.profit, brute.profit, `实例 ${k} (n=${n}) 收益不一致`);
    assert.ok(
      Math.abs(fast.distance - brute.distance) < 1e-6,
      `实例 ${k} (n=${n}) 路程不一致: ${fast.distance} vs ${brute.distance}`,
    );
    // DP 给出的路线本身也必须可行且达到申报指标
    const sim = simulateRoute(inst, fast.route);
    assert.ok(sim.feasible, `实例 ${k} 路线不可行`);
    assert.equal(sim.profit, fast.profit);
  }
});

test("证书校验：合法证书通过，篡改证书被识破", () => {
  const inst = compileInstance(randomSpec(mulberry32(7), 8));
  const cert = buildCertificate(inst, solve(inst));
  assert.deepEqual(verifyCertificate(inst, cert), []);

  const tamperedTime = structuredClone(cert);
  tamperedTime.legs[1]!.arrive += 1;
  assert.ok(verifyCertificate(inst, tamperedTime).length > 0);

  const tamperedProfit = structuredClone(cert);
  tamperedProfit.profit += 1;
  assert.ok(verifyCertificate(inst, tamperedProfit).length > 0);

  const tamperedWindow = structuredClone(cert);
  tamperedWindow.legs[1]!.start = tamperedWindow.legs[1]!.window![1] + 5;
  assert.ok(verifyCertificate(inst, tamperedWindow).length > 0);
});

test("16 站上限：求解可行且不超时限", () => {
  const inst = compileInstance(randomSpec(mulberry32(99), 16));
  const res = solve(inst);
  assert.ok(res.totalTime <= 60 + 1e-9);
  const cert = buildCertificate(inst, res);
  assert.deepEqual(verifyCertificate(inst, cert), []);
});

test("超过 16 站拒绝求解", () => {
  assert.throws(() => compileInstance(randomSpec(mulberry32(1), 17)), /16/);
});
