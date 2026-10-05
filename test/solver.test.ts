import { test } from "node:test";
import { equal, deepEqual, ok, throws } from "node:assert/strict";
import { mainProblem, Problem, Tier } from "../src/problem";
import { solve, priceOrder, verifyCertificate } from "../src/solver";
import { bruteForce } from "../src/brute";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomProblem(seed: number, n: number): Problem {
  const rnd = mulberry32(seed);
  const items = Array.from({ length: n }, (_, i) => ({
    id: `I${i}`,
    name: `item${i}`,
    price: 100 + Math.floor(rnd() * 300) * 100,
  }));
  const tiers: Tier[] = [];
  const tierCount = Math.floor(rnd() * 4);
  let th = 2000 + Math.floor(rnd() * 30) * 500;
  let pct = 3 + Math.floor(rnd() * 15);
  for (let i = 0; i < tierCount; i++) {
    tiers.push({ threshold: th, pct });
    th += 2000 + Math.floor(rnd() * 20) * 500;
    pct += 2 + Math.floor(rnd() * 10);
  }
  const shipping = {
    freeThreshold: 3000 + Math.floor(rnd() * 15) * 1000,
    fee: 300 + Math.floor(rnd() * 10) * 100,
  };
  const couponCount = Math.floor(rnd() * 4);
  const coupons = Array.from({ length: couponCount }, (_, i) => ({
    id: `C${i}`,
    threshold: Math.floor(rnd() * 150) * 100,
    value: 100 + Math.floor(rnd() * 30) * 100,
  }));
  return { items, tiers, shipping, coupons };
}

test("主算例：14 件商品快照（实付最低、单数次优）", () => {
  const sol = solve(mainProblem);
  equal(sol.totalPayable, 69980);
  equal(sol.orderCount, 3);
  deepEqual(sol.certificate.couponUsage, { A: 0, B: 1, C: 2 });
  verifyCertificate(mainProblem, sol.certificate);
});

test("逐单折扣向下取整", () => {
  const p: Problem = {
    items: [{ id: "x", name: "x", price: 19900 }],
    tiers: [{ threshold: 0, pct: 33 }],
    shipping: { freeThreshold: 0, fee: 0 },
    coupons: [],
  };
  // floor(19900 * 33 / 100) = floor(6567.0) = 6567，实付 19900-6567 = 13333
  const line = priceOrder(p, 19900, -1);
  equal(line.discount, 6567);
  equal(line.payable, 13333);
  // 逐单取整：199*33/100 = 65.67 向下取整为 65（而非四舍五入 66）
  const half = priceOrder(p, 199, -1);
  equal(half.discount, 65);
});

test("券全局唯一：同一券不能用于两单", () => {
  const p: Problem = {
    items: [
      { id: "a", name: "a", price: 10000 },
      { id: "b", name: "b", price: 10000 },
    ],
    tiers: [],
    shipping: { freeThreshold: 0, fee: 0 },
    coupons: [{ id: "X", threshold: 0, value: 3000 }],
  };
  const sol = solve(p);
  const used = sol.orders.filter((o) => o.couponId === "X").length;
  ok(used <= 1, "券 X 被重复使用");
  // 若券可复用，两单各抵 3000 共抵 6000；正确结果只能抵一次
  const brute = bruteForce(p);
  equal(sol.totalPayable, brute.totalPayable);
  equal(sol.totalPayable, 17000);
});

test("同价时取更少订单", () => {
  const p: Problem = {
    items: [
      { id: "a", name: "a", price: 1000 },
      { id: "b", name: "b", price: 2000 },
      { id: "c", name: "c", price: 3000 },
    ],
    tiers: [],
    shipping: { freeThreshold: 0, fee: 0 },
    coupons: [],
  };
  const sol = solve(p);
  equal(sol.totalPayable, 6000);
  equal(sol.orderCount, 1);
});

test("空购物车", () => {
  const sol = solve({ items: [], tiers: [], shipping: { freeThreshold: 0, fee: 500 }, coupons: [] });
  equal(sol.totalPayable, 0);
  equal(sol.orderCount, 0);
  equal(sol.orders.length, 0);
});

test("运费门槛：折后不足额收运费", () => {
  const p: Problem = {
    items: [{ id: "a", name: "a", price: 5000 }],
    tiers: [],
    shipping: { freeThreshold: 9900, fee: 800 },
    coupons: [],
  };
  const sol = solve(p);
  equal(sol.totalPayable, 5800);
});

test("证书防篡改：改动金额应校验失败", () => {
  const sol = solve(mainProblem);
  const bad = JSON.parse(JSON.stringify(sol.certificate));
  bad.orders[0].payable += 1;
  throws(() => verifyCertificate(mainProblem, bad));
  const bad2 = JSON.parse(JSON.stringify(sol.certificate));
  bad2.orders[0].couponId = "B"; // 券 B 已在订单 2 使用
  throws(() => verifyCertificate(mainProblem, bad2));
});

test("小件数枚举分区对照：n=1..8 多随机种子", () => {
  for (let n = 1; n <= 8; n++) {
    for (let seed = 0; seed < 5; seed++) {
      const p = randomProblem(seed * 100 + n, n);
      const sol = solve(p);
      const brute = bruteForce(p);
      equal(
        sol.totalPayable,
        brute.totalPayable,
        `n=${n} seed=${seed} 实付不一致`
      );
      equal(
        sol.orderCount,
        brute.orderCount,
        `n=${n} seed=${seed} 单数不一致`
      );
      verifyCertificate(p, sol.certificate);
    }
  }
});

test("小件数枚举分区对照：n=10 抽样", () => {
  for (const seed of [7, 42]) {
    const p = randomProblem(seed, 10);
    const sol = solve(p);
    const brute = bruteForce(p);
    equal(sol.totalPayable, brute.totalPayable, `seed=${seed} 实付不一致`);
    equal(sol.orderCount, brute.orderCount, `seed=${seed} 单数不一致`);
  }
});
