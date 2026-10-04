import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  solve,
  solveBruteForce,
  lineCost,
  unitPriceFor,
  Supplier,
} from "../src/solver";

const sample = JSON.parse(
  readFileSync(__dirname + "/../../config.sample.json", "utf8")
) as { demand: number; suppliers: Supplier[] };

test("阶梯全量单价：整单按所达档位单价计价", () => {
  const s: Supplier = {
    name: "T",
    moq: 1,
    freightThresholdCents: 0,
    freightFeeCents: 0,
    tiers: [
      { minQty: 1, unitPriceCents: 100 },
      { minQty: 10, unitPriceCents: 80 },
    ],
  };
  assert.equal(unitPriceFor(s, 9), 100);
  assert.equal(unitPriceFor(s, 10), 80);
  assert.equal(unitPriceFor(s, 25), 80);
  assert.equal(lineCost(s, 10)!.goodsCents, 800);
});

test("运费门槛：货款达标免运费，否则收运费", () => {
  const s: Supplier = {
    name: "T",
    moq: 1,
    freightThresholdCents: 1000,
    freightFeeCents: 200,
    tiers: [{ minQty: 1, unitPriceCents: 100 }],
  };
  assert.equal(lineCost(s, 9)!.freightCents, 200);
  assert.equal(lineCost(s, 10)!.freightCents, 0);
  assert.equal(lineCost(s, 9)!.totalCents, 1100);
});

test("起订量：低于 MOQ 不可下单", () => {
  const s: Supplier = {
    name: "T",
    moq: 5,
    freightThresholdCents: 0,
    freightFeeCents: 0,
    tiers: [{ minQty: 1, unitPriceCents: 100 }],
  };
  assert.equal(lineCost(s, 4), null);
  assert.notEqual(lineCost(s, 5), null);
});

test("数量恰等需求：6 供应商总需求 200", () => {
  const r = solve(sample.suppliers, 200);
  const sum = r.lines.reduce((a, l) => a + l.qty, 0);
  assert.equal(sum, 200);
  assert.ok(r.supplierCount <= 6);
  const recomputed = r.lines.reduce((a, l) => a + l.totalCents, 0);
  assert.equal(recomputed, r.totalCents);
  for (const l of r.lines) {
    const s = sample.suppliers.find((x) => x.name === l.supplier)!;
    assert.ok(l.qty >= s.moq, `${l.supplier} 违反起订量`);
  }
});

test("目标次序：费用最小优先，再比供应商数量少", () => {
  const suppliers: Supplier[] = [
    {
      name: "cheap-solo",
      moq: 1,
      freightThresholdCents: 0,
      freightFeeCents: 0,
      tiers: [{ minQty: 1, unitPriceCents: 100 }],
    },
    {
      name: "split-a",
      moq: 1,
      freightThresholdCents: 0,
      freightFeeCents: 0,
      tiers: [{ minQty: 1, unitPriceCents: 100 }],
    },
  ];
  const r = solve(suppliers, 10);
  assert.equal(r.totalCents, 1000);
  assert.equal(r.supplierCount, 1);

  const withFreight: Supplier[] = [
    {
      name: "one",
      moq: 1,
      freightThresholdCents: 100000,
      freightFeeCents: 500,
      tiers: [{ minQty: 1, unitPriceCents: 100 }],
    },
    {
      name: "two",
      moq: 1,
      freightThresholdCents: 100000,
      freightFeeCents: 500,
      tiers: [{ minQty: 1, unitPriceCents: 90 }],
    },
  ];
  const r2 = solve(withFreight, 10);
  assert.equal(r2.supplierCount, 1);
  assert.equal(r2.totalCents, 1400);
});

test("拆单更省时会选择多供应商", () => {
  const suppliers: Supplier[] = [
    {
      name: "A",
      moq: 1,
      freightThresholdCents: 0,
      freightFeeCents: 0,
      tiers: [
        { minQty: 1, unitPriceCents: 90 },
        { minQty: 6, unitPriceCents: 1000 },
      ],
    },
    {
      name: "B",
      moq: 1,
      freightThresholdCents: 0,
      freightFeeCents: 0,
      tiers: [{ minQty: 1, unitPriceCents: 100 }],
    },
  ];
  const r = solve(suppliers, 10);
  assert.equal(r.totalCents, 950);
  assert.equal(r.supplierCount, 2);
  const brute = solveBruteForce(suppliers, 10);
  assert.equal(brute.totalCents, 950);
  assert.equal(brute.supplierCount, 2);
});

test("全枚举验收：小需求下 DP 与全枚举一致（样例 6 供应商）", () => {
  for (let demand = 1; demand <= 25; demand++) {
    const fast = solve(sample.suppliers, demand);
    const brute = solveBruteForce(sample.suppliers, demand);
    assert.equal(fast.totalCents, brute.totalCents, `demand=${demand} 费用不一致`);
    assert.equal(fast.supplierCount, brute.supplierCount, `demand=${demand} 供应商家数不一致`);
    assert.equal(fast.lines.reduce((a, l) => a + l.qty, 0), demand);
  }
});

test("全枚举验收：随机供应商小需求 fuzz", () => {
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let iter = 0; iter < 60; iter++) {
    const n = 1 + Math.floor(rand() * 4);
    const suppliers: Supplier[] = [];
    for (let i = 0; i < n; i++) {
      const tiers = [{ minQty: 1, unitPriceCents: 50 + Math.floor(rand() * 100) }];
      if (rand() < 0.7) {
        tiers.push({ minQty: 3 + Math.floor(rand() * 6), unitPriceCents: tiers[0].unitPriceCents - Math.floor(rand() * 30) });
      }
      suppliers.push({
        name: `S${i}`,
        moq: i === 0 ? 1 : 1 + Math.floor(rand() * 5),
        freightThresholdCents: Math.floor(rand() * 800),
        freightFeeCents: Math.floor(rand() * 300),
        tiers,
      });
    }
    const demand = 1 + Math.floor(rand() * 15);
    const fast = solve(suppliers, demand);
    const brute = solveBruteForce(suppliers, demand);
    assert.equal(fast.totalCents, brute.totalCents, `iter=${iter} demand=${demand}`);
    assert.equal(fast.supplierCount, brute.supplierCount, `iter=${iter} demand=${demand}`);
  }
});

test("不可行时抛错", () => {
  const s: Supplier[] = [
    {
      name: "big-moq",
      moq: 10,
      freightThresholdCents: 0,
      freightFeeCents: 0,
      tiers: [{ minQty: 1, unitPriceCents: 100 }],
    },
  ];
  assert.throws(() => solve(s, 5), /no feasible plan/);
});

test("超过 6 个供应商抛错", () => {
  const s: Supplier = {
    name: "x",
    moq: 1,
    freightThresholdCents: 0,
    freightFeeCents: 0,
    tiers: [{ minQty: 1, unitPriceCents: 100 }],
  };
  assert.throws(() => solve(Array(7).fill(s), 10), /at most 6/);
});
