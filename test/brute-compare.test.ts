import { test } from "node:test";
import assert from "node:assert/strict";
import { bruteForceSolve } from "../src/brute.js";
import { verifySolution } from "../src/certificate.js";
import { solveCart } from "../src/solver.js";
import type { CartRules, Coupon, Item } from "../src/types.js";

/** 确定性伪随机数（mulberry32），保证测试可复现。 */
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

test("小件数枚举分区对照：DP 与暴力枚举全量一致", () => {
  const rand = mulberry32(20261005);
  let cases = 0;
  let partitionsTotal = 0;
  for (let trial = 0; trial < 60; trial++) {
    const n = 1 + Math.floor(rand() * 8); // 1..8 件
    const c = Math.floor(rand() * 4); // 0..3 张券
    const items: Item[] = Array.from({ length: n }, (_, i) => ({
      id: `t${trial}-i${i}`,
      name: `i${i}`,
      price: 100 + Math.floor(rand() * 19900), // 1..200 元
    }));
    const rules: CartRules = {
      discount: {
        step: [5000, 8000, 10000][Math.floor(rand() * 3)],
        off: 300 + Math.floor(rand() * 15) * 100,
        cap: rand() < 0.5 ? undefined : 2000 + Math.floor(rand() * 3) * 1000,
      },
      shipping: {
        fee: 300 + Math.floor(rand() * 8) * 100,
        freeAbove: 5000 + Math.floor(rand() * 16) * 1000,
      },
    };
    const coupons: Coupon[] = Array.from({ length: c }, (_, j) => ({
      id: `t${trial}-c${j}`,
      minSpend: Math.floor(rand() * 12) * 1000,
      value: 200 + Math.floor(rand() * 20) * 100,
    }));

    const dp = solveCart(items, rules, coupons);
    const brute = bruteForceSolve(items, rules, coupons);
    partitionsTotal += brute.partitionsChecked;

    assert.equal(
      dp.totalPay,
      brute.totalPay,
      `trial ${trial}: 实付不一致 dp=${dp.totalPay} brute=${brute.totalPay}`,
    );
    assert.equal(
      dp.orderCount,
      brute.orderCount,
      `trial ${trial}: 订单数不一致 dp=${dp.orderCount} brute=${brute.orderCount}`,
    );
    assert.deepEqual(verifySolution(items, rules, coupons, dp), []);
    cases++;
  }
  console.log(`  对照通过: ${cases} 个随机用例，累计枚举 ${partitionsTotal} 种划分`);
});

test("枚举规模校验：n=8 时划分数量为 Bell(8)=4140", () => {
  const items: Item[] = Array.from({ length: 8 }, (_, i) => ({
    id: `b${i}`,
    name: `b${i}`,
    price: 1000,
  }));
  const rules: CartRules = {
    discount: { step: 10 ** 9, off: 0 },
    shipping: { fee: 0, freeAbove: 0 },
  };
  const brute = bruteForceSolve(items, rules, []);
  assert.equal(brute.partitionsChecked, 4140);
  assert.equal(brute.totalPay, 8000);
  assert.equal(brute.orderCount, 1);
});
