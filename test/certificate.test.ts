import { test } from "node:test";
import assert from "node:assert/strict";
import { verifySolution } from "../src/certificate.js";
import { sampleCoupons, sampleItems, sampleRules } from "../src/sample.js";
import { solveCart } from "../src/solver.js";

test("14 件商品样例：求解并核验券证书", () => {
  const sol = solveCart(sampleItems, sampleRules, sampleCoupons);
  assert.deepEqual(verifySolution(sampleItems, sampleRules, sampleCoupons, sol), []);
  assert.ok(sol.orderCount >= 1 && sol.orderCount <= 14);
  console.log(
    `  样例结果: 总实付 ${(sol.totalPay / 100).toFixed(2)} 元, ${sol.orderCount} 单, ` +
      `用券 ${sol.orders.filter((o) => o.couponId !== null).length} 张`,
  );
});

test("篡改检测：一券两用被证书核验拒绝", () => {
  const sol = solveCart(sampleItems, sampleRules, sampleCoupons);
  // 强制让两个订单使用同一张券
  const couponId = sampleCoupons[0].id;
  sol.orders[0].couponId = couponId;
  sol.orders[1].couponId = couponId;
  const violations = verifySolution(sampleItems, sampleRules, sampleCoupons, sol);
  assert.ok(violations.some((v) => v.includes("全局限一次")));
});

test("篡改检测：虚报满减金额被逐单重算拒绝", () => {
  const sol = solveCart(sampleItems, sampleRules, sampleCoupons);
  sol.orders[0].discount += 100;
  const violations = verifySolution(sampleItems, sampleRules, sampleCoupons, sol);
  assert.ok(violations.some((v) => v.includes("满减不符")));
});

test("篡改检测：漏分商品被划分校验拒绝", () => {
  const sol = solveCart(sampleItems, sampleRules, sampleCoupons);
  sol.orders[0].itemIds.pop();
  const violations = verifySolution(sampleItems, sampleRules, sampleCoupons, sol);
  assert.ok(violations.some((v) => v.includes("未被分配")));
});
