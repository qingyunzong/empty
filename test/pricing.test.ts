import { test } from "node:test";
import assert from "node:assert/strict";
import { orderCost, orderDiscount, shippingFee } from "../src/pricing.js";
import type { CartRules } from "../src/types.js";

const rules: CartRules = {
  discount: { step: 10000, off: 1500, cap: 4500 },
  shipping: { fee: 800, freeAbove: 9900 },
};

test("逐单满减向下取整：19999 只计 1 个满减档", () => {
  assert.equal(orderDiscount(19999, rules.discount), 1500);
  assert.equal(orderDiscount(20000, rules.discount), 3000);
  assert.equal(orderDiscount(9999, rules.discount), 0);
});

test("满减封顶：50000 触发 5 档但封顶 4500", () => {
  assert.equal(orderDiscount(50000, rules.discount), 4500);
  assert.equal(orderDiscount(999999, rules.discount), 4500);
});

test("运费门槛按折后金额判断", () => {
  assert.equal(shippingFee(9900, rules.shipping), 0);
  assert.equal(shippingFee(9899, rules.shipping), 800);
});

test("券门槛按商品小计判断，券不使商品应付为负", () => {
  const cost = orderCost(10000, rules, { id: "X", minSpend: 10001, value: 3000 });
  assert.equal(cost.couponValue, 0); // 小计未达券门槛
  const cheap = orderCost(300, rules, { id: "Y", minSpend: 0, value: 500 });
  assert.equal(cheap.couponValue, 500);
  assert.equal(cheap.payable, 800); // 商品 300-500 截断为 0，仍收运费 800
});

test("整单费用合成", () => {
  const cost = orderCost(21000, rules, { id: "Z", minSpend: 15000, value: 3000 });
  // 小计 21000，满减 3000，券 3000，折后 18000 包邮
  assert.deepEqual(cost, {
    subtotal: 21000,
    discount: 3000,
    couponValue: 3000,
    shipping: 0,
    payable: 15000,
  });
});
