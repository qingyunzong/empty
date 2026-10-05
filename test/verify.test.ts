import { test } from "node:test";
import assert from "node:assert/strict";
import { solvePlan, verifyCertificate } from "../src/index.js";
import type { PlanCertificate, PlanInput } from "../src/index.js";

const input: PlanInput = {
  orders: [
    { id: "A", location: 1, readyTime: 0, dueTime: 100, duration: 2, revenue: 10 },
    { id: "B", location: 2, readyTime: 5, dueTime: 100, duration: 1, revenue: 10 },
  ],
  vehicles: [{ id: "v0", startLocation: 0, availableTime: 0, costPerUnitTime: 1 }],
  emptyTime: [
    [0, 3, 8],
    [3, 0, 4],
    [8, 4, 0],
  ],
};

function solved(): PlanCertificate {
  return solvePlan(input);
}

test("合法证书通过核对", () => {
  assert.deepStrictEqual(verifyCertificate(input, solved()), []);
});

test("篡改利润被检出", () => {
  const cert = solved();
  cert.profit += 1;
  const errors = verifyCertificate(input, cert);
  assert.ok(errors.some((e) => e.includes("profit")), errors.join("; "));
});

test("篡改到达时间被检出", () => {
  const cert = solved();
  cert.routes[0].stops[0].arrivalTime += 1;
  const errors = verifyCertificate(input, cert);
  assert.ok(errors.some((e) => e.includes("arrivalTime")), errors.join("; "));
});

test("订单重复服务被检出", () => {
  const cert = solved();
  const dup = { ...cert.routes[0].stops[0] };
  cert.routes[0].stops.push(dup);
  const errors = verifyCertificate(input, cert);
  assert.ok(errors.some((e) => e.includes("served by both")), errors.join("; "));
});

test("分配向量与路线不一致被检出", () => {
  const cert = solved();
  cert.assignment[0] = null;
  const errors = verifyCertificate(input, cert);
  assert.ok(errors.some((e) => e.includes("unassigned")), errors.join("; "));
});

test("违反 dueTime 的路线被检出", () => {
  const cert = solved();
  const tighter: PlanInput = {
    ...input,
    orders: input.orders.map((o, i) => (i === 1 ? { ...o, dueTime: 6 } : o)),
  };
  const errors = verifyCertificate(tighter, cert);
  assert.ok(errors.some((e) => e.includes("dueTime")), errors.join("; "));
});
