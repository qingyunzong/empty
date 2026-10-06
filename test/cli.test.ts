import { test } from "./harness";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runCli } from "../src/cli";

test("CLI：读取 JSON，输出最优解与逐时段验证，--verify 与枚举一致", () => {
  const { code, stdout } = runCli(["example.json", "--verify"]);
  assert.equal(code, 0);
  const r = JSON.parse(stdout);
  assert.equal(r.feasible, true);
  assert.equal(r.verification.match, true);
  assert.equal(typeof r.totalCost, "number");
  assert.equal(r.totalQty >= 100, true);
  assert.equal(r.totalQty <= 110, true);
  assert.equal(r.overPurchase, r.totalQty - 100);
  // 互斥 [A,B]：不可同时有量
  assert.ok(r.quantities.A === 0 || r.quantities.B === 0);
  // 依赖 D->C：D 有量则 C 必有量
  if (r.quantities.D > 0) assert.ok(r.quantities.C > 0);
  // 逐时段验证全部通过
  for (const s of r.slots) {
    assert.equal(s.ok, true);
    assert.equal(s.shortage, 0);
    assert.ok(s.arrivals <= s.capacity);
  }
});

test("CLI：stdin 输入不可行时 code=1 且 feasible=false", () => {
  const input = JSON.stringify({
    demand: 10,
    cap: 10,
    suppliers: [
      { id: "A", minQty: 1, maxQty: 5, arrivalSlot: 0, tiers: [{ upTo: 5, unitPrice: 1 }] },
    ],
    slotCapacity: [80],
    slotDemand: [0],
  });
  const { code, stdout } = runCli(["-"], input);
  assert.equal(code, 1);
  assert.equal(JSON.parse(stdout).feasible, false);
});

test("CLI：与 example.json 文件读取路径一致", () => {
  const raw = readFileSync("example.json", "utf8");
  const a = runCli(["example.json"]);
  const b = runCli(["-"], raw);
  assert.equal(a.stdout, b.stdout);
  assert.equal(a.code, b.code);
});
