import { test } from "node:test";
import assert from "node:assert/strict";
import { solveCart } from "../src/solver.js";
import { verifySolution } from "../src/certificate.js";
import type { CartRules, Item } from "../src/types.js";

const item = (id: string, price: number): Item => ({ id, name: id, price });

test("实付并列时取订单数更少", () => {
  // 无满减、无运费、无券：任意拆分实付相同，应只下 1 单
  const rules: CartRules = {
    discount: { step: 10 ** 9, off: 0 },
    shipping: { fee: 0, freeAbove: 0 },
  };
  const sol = solveCart([item("a", 100), item("b", 200), item("c", 300)], rules, []);
  assert.equal(sol.totalPay, 600);
  assert.equal(sol.orderCount, 1);
});

test("为省运费而拆/并单", () => {
  // 满 100 包邮；两商品合并 9900+200=10100 包邮，分开各付 800 运费
  const rules: CartRules = {
    discount: { step: 10 ** 9, off: 0 },
    shipping: { fee: 800, freeAbove: 10000 },
  };
  const sol = solveCart([item("a", 9900), item("b", 200)], rules, []);
  assert.equal(sol.totalPay, 10100);
  assert.equal(sol.orderCount, 1);
});

test("券全局限用一次：两单都想要同一张券时只能用一次", () => {
  const rules: CartRules = {
    discount: { step: 10 ** 9, off: 0 },
    shipping: { fee: 0, freeAbove: 0 },
  };
  const coupons = [{ id: "C1", minSpend: 0, value: 1000 }];
  const sol = solveCart([item("a", 5000), item("b", 5000)], rules, coupons);
  // 无论拆几单，券只能抵一次 1000
  assert.equal(sol.totalPay, 9000);
  const used = sol.orders.filter((o) => o.couponId === "C1").length;
  assert.equal(used, 1);
  assert.equal(sol.certificate.eachCouponUsedAtMostOnce, true);
});

test("拆单触发两次满减更优", () => {
  // 每满 10000 减 1500；两件 10000 的商品：合并 20000 减 3000，
  // 拆分各减 1500 同样 3000，但拆单多一笔运费——验证求解器权衡
  const rules: CartRules = {
    discount: { step: 10000, off: 1500 },
    shipping: { fee: 800, freeAbove: 19000 },
  };
  const items = [item("a", 10000), item("b", 10000)];
  const sol = solveCart(items, rules, []);
  // 合并：20000-3000=17000 <19000 运费 800 → 17800
  // 拆分：(10000-1500+800)*2 = 18600
  assert.equal(sol.totalPay, 17800);
  assert.equal(sol.orderCount, 1);
});

test("空购物车与超上限报错", () => {
  const rules: CartRules = {
    discount: { step: 100, off: 10 },
    shipping: { fee: 0, freeAbove: 0 },
  };
  assert.throws(() => solveCart([], rules, []));
  const tooMany = Array.from({ length: 15 }, (_, i) => item(`i${i}`, 100));
  assert.throws(() => solveCart(tooMany, rules, []));
});

test("求解结果通过独立核验", () => {
  const rules: CartRules = {
    discount: { step: 5000, off: 700, cap: 2100 },
    shipping: { fee: 600, freeAbove: 8000 },
  };
  const coupons = [
    { id: "C1", minSpend: 9000, value: 1500 },
    { id: "C2", minSpend: 0, value: 300 },
  ];
  const items = Array.from({ length: 10 }, (_, i) => item(`i${i}`, 800 + i * 1130));
  const sol = solveCart(items, rules, coupons);
  assert.deepEqual(verifySolution(items, rules, coupons, sol), []);
});
