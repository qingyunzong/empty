import { test } from "node:test";
import * as assert from "node:assert/strict";
import { supplierCostCents, unitPriceCentsFor } from "../src/cost";
import { parseSuppliers } from "../src/config";
import { solveByEnumeration } from "../src/enumerate";
import { solve } from "../src/solve";
import type { Supplier, Tier } from "../src/types";

function makeSupplier(overrides: Partial<Supplier> & { id: string }): Supplier {
  return {
    moq: 1,
    tiers: [{ minQty: 1, unitPriceCents: 100 }],
    shipping: { freeAboveCents: 0, feeCents: 0 },
    ...overrides,
  };
}

test("阶梯全量单价：达到档位后全部数量按该档单价计", () => {
  const tiers: Tier[] = [
    { minQty: 1, unitPriceCents: 500 },
    { minQty: 10, unitPriceCents: 400 },
  ];
  assert.equal(unitPriceCentsFor(tiers, 9), 500);
  assert.equal(unitPriceCentsFor(tiers, 10), 400);
  const s = makeSupplier({ id: "X", tiers });
  assert.equal(supplierCostCents(s, 10), 10 * 400); // 全量 400，而非分段累计
});

test("运费门槛：商品金额达到门槛免运费，否则收运费", () => {
  const s = makeSupplier({
    id: "X",
    tiers: [{ minQty: 1, unitPriceCents: 100 }],
    shipping: { freeAboveCents: 5000, feeCents: 300 },
  });
  assert.equal(supplierCostCents(s, 49), 4900 + 300);
  assert.equal(supplierCostCents(s, 50), 5000); // 恰好达到门槛，免运费
});

test("起订量：0 或 >= moq 可行，其余不可行", () => {
  const s = makeSupplier({ id: "X", moq: 10 });
  assert.equal(supplierCostCents(s, 0), 0);
  assert.equal(supplierCostCents(s, 5), Number.POSITIVE_INFINITY);
  assert.equal(supplierCostCents(s, 10), 1000);
});

test("数量恰等需求：无法满足时返回不可行", () => {
  const s = makeSupplier({ id: "X", moq: 10 });
  const sol = solve([s], 5);
  assert.equal(sol.feasible, false);
  assert.equal(solve([s], 10).feasible, true);
});

test("需求为 0：不采购，费用 0，供应商数 0", () => {
  const sol = solve([makeSupplier({ id: "X", moq: 5 })], 0);
  assert.deepEqual(sol, { feasible: true, demand: 0, totalCents: 0, supplierCount: 0, allocations: [] });
});

test("手算最优：运费与阶梯共同影响", () => {
  const a = makeSupplier({ id: "A", tiers: [{ minQty: 1, unitPriceCents: 100 }] });
  const b = makeSupplier({
    id: "B",
    moq: 8,
    tiers: [{ minQty: 1, unitPriceCents: 90 }],
    shipping: { freeAboveCents: 100000, feeCents: 500 },
  });
  // 全 A=1000；全 B=1400；B8+A2=1420 → 最优全 A
  const sol = solve([a, b], 10);
  assert.equal(sol.totalCents, 1000);
  assert.equal(sol.supplierCount, 1);
  assert.equal(sol.allocations[0]!.supplierId, "A");

  // B 增加 10 件档 60 分且免运费：全 B=600 最优
  const b2 = makeSupplier({
    id: "B",
    moq: 8,
    tiers: [
      { minQty: 1, unitPriceCents: 90 },
      { minQty: 10, unitPriceCents: 60 },
    ],
  });
  const sol2 = solve([a, b2], 10);
  assert.equal(sol2.totalCents, 600);
  assert.equal(sol2.allocations[0]!.supplierId, "B");
});

test("费用相同则供应商数量更少者胜", () => {
  const a = makeSupplier({ id: "A" });
  const b = makeSupplier({ id: "B" });
  const sol = solve([a, b], 10);
  assert.equal(sol.totalCents, 1000);
  assert.equal(sol.supplierCount, 1);
});

test("DP 与全枚举在小需求下结果一致（随机配置验收）", () => {
  let seed = 20261005 >>> 0;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const randomSupplier = (id: string): Supplier => {
    const tierCount = 1 + Math.floor(rand() * 3);
    const tiers: Tier[] = [];
    let minQty = 1;
    for (let i = 0; i < tierCount; i++) {
      tiers.push({ minQty, unitPriceCents: 50 + Math.floor(rand() * 250) });
      minQty += 1 + Math.floor(rand() * 6);
    }
    return {
      id,
      moq: 1 + Math.floor(rand() * 5),
      tiers,
      shipping: { freeAboveCents: Math.floor(rand() * 3000), feeCents: Math.floor(rand() * 500) },
    };
  };

  const cases = 300;
  for (let c = 0; c < cases; c++) {
    const n = 1 + Math.floor(rand() * 4); // 1..4 家
    const suppliers = Array.from({ length: n }, (_, i) => randomSupplier(`S${i}`));
    const demand = Math.floor(rand() * 19); // 0..18
    const dp = solve(suppliers, demand);
    const brute = solveByEnumeration(suppliers, demand);
    assert.equal(dp.feasible, brute.feasible, `case ${c} feasible mismatch (demand=${demand})`);
    if (dp.feasible) {
      assert.equal(dp.totalCents, brute.totalCents, `case ${c} cost mismatch (demand=${demand})`);
      assert.equal(dp.supplierCount, brute.supplierCount, `case ${c} count mismatch (demand=${demand})`);
      const qtySum = dp.allocations.reduce((sum, a) => sum + a.qty, 0);
      assert.equal(qtySum, demand, `case ${c} qty sum must equal demand`);
    }
  }
});

test("配置校验：最多 6 家供应商、金额为整数分", () => {
  const seven = Array.from({ length: 7 }, (_, i) => ({
    id: `S${i}`,
    moq: 1,
    tiers: [{ minQty: 1, unitPriceCents: 100 }],
    shipping: { freeAboveCents: 0, feeCents: 0 },
  }));
  assert.throws(() => parseSuppliers(seven), /at most 6 suppliers/);
  assert.throws(
    () =>
      parseSuppliers([
        { id: "A", moq: 1, tiers: [{ minQty: 1, unitPriceCents: 10.5 }], shipping: { freeAboveCents: 0, feeCents: 0 } },
      ]),
    /must be an integer/,
  );
  const ok = parseSuppliers({
    suppliers: [{ id: "A", moq: 2, tiers: [{ minQty: 1, unitPriceCents: 100 }], shipping: { freeAboveCents: 0, feeCents: 0 } }],
  });
  assert.equal(ok.length, 1);
  assert.equal(ok[0]!.id, "A");
});
