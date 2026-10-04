import { test } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { run } from "../src/app";
import { parseSuppliers } from "../src/config";
import { solve } from "../src/solve";
import type { Solution } from "../src/types";

const EXAMPLE = "examples/suppliers.json";

test("CLI：6 家供应商、总需求 200，输出与求解器一致", () => {
  const { code, stdout, stderr } = run(["--demand", "200", "--suppliers", EXAMPLE], () => {
    throw new Error("should not read stdin");
  });
  assert.equal(stderr, "");
  assert.equal(code, 0);
  const out = JSON.parse(stdout) as Solution;
  assert.equal(out.feasible, true);
  assert.equal(out.demand, 200);
  assert.equal(out.allocations.reduce((s, a) => s + a.qty, 0), 200); // 数量恰等需求
  assert.equal(out.allocations.length, out.supplierCount);
  assert.ok(out.supplierCount >= 1 && out.supplierCount <= 6);

  const suppliers = parseSuppliers(JSON.parse(readFileSync(EXAMPLE, "utf8")));
  const expected = solve(suppliers, 200);
  assert.equal(out.totalCents, expected.totalCents);
  assert.equal(out.supplierCount, expected.supplierCount);
});

test("CLI：缺省 --suppliers 时从标准输入读取，缺省需求为 200", () => {
  const config = readFileSync(EXAMPLE, "utf8");
  const { code, stdout } = run([], () => config);
  assert.equal(code, 0);
  const out = JSON.parse(stdout) as Solution;
  assert.equal(out.feasible, true);
  assert.equal(out.demand, 200);
});

test("CLI：--enumerate 小需求与 DP 结果一致", () => {
  const config = readFileSync(EXAMPLE, "utf8");
  const dp = JSON.parse(run(["--demand", "20"], () => config).stdout) as Solution;
  const en = JSON.parse(run(["--demand", "20", "--enumerate"], () => config).stdout) as Solution;
  assert.equal(dp.feasible, en.feasible);
  assert.equal(dp.totalCents, en.totalCents);
  assert.equal(dp.supplierCount, en.supplierCount);
});

test("CLI：无可行方案时退出码为 2", () => {
  const config = JSON.stringify({
    suppliers: [
      { id: "A", moq: 10, tiers: [{ minQty: 1, unitPriceCents: 100 }], shipping: { freeAboveCents: 0, feeCents: 0 } },
    ],
  });
  const { code, stdout } = run(["--demand", "5"], () => config);
  assert.equal(code, 2);
  assert.equal((JSON.parse(stdout) as Solution).feasible, false);
});

test("CLI：非法需求与非法配置退出码为 1", () => {
  const bad = run(["--demand", "abc"], () => "{}");
  assert.equal(bad.code, 1);
  assert.ok(bad.stderr.includes("--demand"));
  assert.equal(run([], () => "not json").code, 1);
  assert.equal(run(["--suppliers", "no/such/file.json"], () => "").code, 1);
});

test("CLI：--help 输出用法", () => {
  const { code, stdout } = run(["--help"], () => "");
  assert.equal(code, 0);
  assert.ok(stdout.includes("--demand"));
});
