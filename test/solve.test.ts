import { test } from "./harness";
import assert from "node:assert/strict";
import { Problem, priceOf, Supplier } from "../src/model";
import {
  compareCandidates,
  maskSatisfiesContracts,
  solveDp,
  solveEnumerate,
  verifySchedule,
} from "../src/solve";

function sup(partial: Partial<Supplier> & { id: string }): Supplier {
  return {
    minQty: 1,
    arrivalSlot: 0,
    tiers: [{ upTo: 80, unitPrice: 1 }],
    ...partial,
  };
}

function base(partial: Partial<Problem>): Problem {
  return {
    demand: 10,
    cap: 12,
    suppliers: [sup({ id: "A" })],
    slotCapacity: [80],
    slotDemand: [0],
    ...partial,
  };
}

test("全量阶梯计价：整单按所在档位单价", () => {
  const s = sup({
    id: "A",
    tiers: [
      { upTo: 10, unitPrice: 5 },
      { upTo: 80, unitPrice: 3 },
    ],
  });
  assert.equal(priceOf(s, 0), 0);
  assert.equal(priceOf(s, 10), 50);
  assert.equal(priceOf(s, 11), 33); // 全部 11 件按 3 元，而非分段
});

test("起订量：只能取 0 或 [minQty, maxQty]", () => {
  const p = base({
    demand: 3,
    cap: 80,
    suppliers: [sup({ id: "A", minQty: 5 })],
  });
  const r = solveDp(p);
  assert.equal(r.feasible, true);
  assert.equal(r.best?.qty[0], 5); // 不可订 3，最少订 5
});

test("目标序：总价优先于超购", () => {
  // A 便宜但需超购，B 刚好满足但总价更高 -> 选 A
  const p = base({
    demand: 10,
    cap: 20,
    suppliers: [
      sup({ id: "A", minQty: 15, tiers: [{ upTo: 80, unitPrice: 1 }] }),
      sup({ id: "B", minQty: 10, tiers: [{ upTo: 80, unitPrice: 3 }] }),
    ],
  });
  const r = solveDp(p);
  assert.deepEqual(r.best?.qty, [15, 0]);
  assert.equal(r.best?.totalCost, 15);
});

test("目标序：同价时超购少者优先", () => {
  const p = base({
    demand: 7,
    cap: 12,
    suppliers: [sup({ id: "A", minQty: 5, tiers: [{ upTo: 80, unitPrice: 0 }] })],
  });
  const r = solveDp(p);
  assert.equal(r.best?.totalQty, 7);
});

test("目标序：同价同量时数量向量字典序小者优先", () => {
  const p = base({
    demand: 10,
    cap: 10,
    suppliers: [sup({ id: "A" }), sup({ id: "B" })],
  });
  const r = solveDp(p);
  assert.equal(r.best?.totalCost, 10);
  assert.deepEqual(r.best?.qty, [0, 10]); // (0,10) 字典序最小
});

test("互斥：两家不可同时下单", () => {
  const p = base({
    demand: 10,
    cap: 10,
    suppliers: [sup({ id: "A" }), sup({ id: "B" })],
    exclusions: [[0, 1]],
  });
  const r = solveDp(p);
  assert.deepEqual(r.best?.qty, [0, 10]);
  // 需求超过单家上限时无可行解
  const p2 = base({
    demand: 10,
    cap: 10,
    suppliers: [sup({ id: "A", maxQty: 6 }), sup({ id: "B", maxQty: 6 })],
    exclusions: [[0, 1]],
  });
  assert.equal(solveDp(p2).feasible, false);
});

test("依赖：向 A 下单必须也向 B 下单", () => {
  const p = base({
    demand: 5,
    cap: 5,
    suppliers: [
      sup({ id: "A", tiers: [{ upTo: 80, unitPrice: 1 }] }),
      sup({ id: "B", tiers: [{ upTo: 80, unitPrice: 100 }] }),
    ],
    dependencies: [[0, 1]],
  });
  const r = solveDp(p);
  // 无依赖时最优为 [5,0]（成本 5）；有依赖须带上 B，最优 [4,1]（成本 104）
  assert.deepEqual(r.best?.qty, [4, 1]);
  assert.equal(r.best?.totalCost, 104);
  const noDep = solveDp(base({
    demand: 5,
    cap: 5,
    suppliers: [
      sup({ id: "A", tiers: [{ upTo: 80, unitPrice: 1 }] }),
      sup({ id: "B", tiers: [{ upTo: 80, unitPrice: 100 }] }),
    ],
  }));
  assert.deepEqual(noDep.best?.qty, [5, 0]);
  assert.equal(maskSatisfiesContracts(p, 0b01), false);
  assert.equal(maskSatisfiesContracts(p, 0b11), true);
});

test("时段共享容量：同时段到货量之和受限", () => {
  const p = base({
    demand: 10,
    cap: 10,
    suppliers: [sup({ id: "A" }), sup({ id: "B" })],
    slotCapacity: [8],
  });
  assert.equal(solveDp(p).feasible, false);
  const p2 = base({
    demand: 10,
    cap: 10,
    suppliers: [sup({ id: "A", arrivalSlot: 0 }), sup({ id: "B", arrivalSlot: 1 })],
    slotCapacity: [8, 8],
    slotDemand: [0, 0],
  });
  const r2 = solveDp(p2);
  assert.equal(r2.feasible, true);
  assert.equal(r2.best?.totalQty, 10);
});

test("逐时段缺货：晚到供应商无法覆盖早时段需求", () => {
  const p = base({
    demand: 5,
    cap: 10,
    suppliers: [sup({ id: "A", arrivalSlot: 1 })],
    slotCapacity: [80, 80],
    slotDemand: [5, 0],
  });
  assert.equal(solveDp(p).feasible, false);
  // 有时段 0 的供应商则可行
  const p2 = base({
    demand: 5,
    cap: 10,
    suppliers: [sup({ id: "A", arrivalSlot: 0, tiers: [{ upTo: 80, unitPrice: 2 }] }), sup({ id: "B", arrivalSlot: 1 })],
    slotCapacity: [80, 80],
    slotDemand: [5, 0],
  });
  const r2 = solveDp(p2);
  assert.equal(r2.feasible, true);
  assert.deepEqual(r2.best?.qty, [5, 0]);
});

test("逐时段缺货验证报告", () => {
  const p = base({
    demand: 8,
    cap: 10,
    suppliers: [
      sup({ id: "A", arrivalSlot: 0, maxQty: 5 }),
      sup({ id: "B", arrivalSlot: 1, maxQty: 5 }),
    ],
    slotCapacity: [5, 5],
    slotDemand: [4, 4],
  });
  const report = verifySchedule(p, [5, 3]);
  assert.deepEqual(
    report.map((s) => [s.arrivals, s.cumArrivals, s.cumDemand, s.shortage, s.ok]),
    [
      [5, 5, 4, 0, true],
      [3, 8, 8, 0, true],
    ]
  );
  const bad = verifySchedule(p, [3, 5]);
  assert.equal(bad[0]?.ok, false);
  assert.equal(bad[0]?.shortage, 1);
  assert.equal(bad[1]?.shortage, 0);
  const worse = verifySchedule(p, [2, 5]);
  assert.equal(worse[0]?.shortage, 2);
  assert.equal(worse[0]?.ok, false);
});

test("compareCandidates 目标序", () => {
  const mk = (cost: number, total: number, qty: number[]) => ({
    totalCost: cost,
    totalQty: total,
    qty,
  });
  assert.ok(compareCandidates(mk(10, 10, [10]), mk(11, 10, [0, 10])) < 0);
  assert.ok(compareCandidates(mk(10, 10, [10]), mk(10, 11, [11])) < 0);
  assert.ok(compareCandidates(mk(10, 10, [0, 10]), mk(10, 10, [10, 0])) < 0);
});

// ---- 随机小例：DP 与枚举对照 ----

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

function randomProblem(rand: () => number): Problem {
  const ri = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const n = ri(1, 4);
  const T = ri(1, 3);
  const suppliers: Supplier[] = [];
  for (let i = 0; i < n; i++) {
    const minQty = ri(1, 3);
    const maxQty = minQty + ri(0, 4);
    const tiers = maxQty < 2 || rand() < 0.5
      ? [{ upTo: maxQty, unitPrice: ri(1, 9) }]
      : [
          { upTo: ri(1, maxQty - 1), unitPrice: ri(2, 9) },
          { upTo: maxQty, unitPrice: ri(1, 8) },
        ];
    suppliers.push({
      id: `S${i}`,
      minQty,
      maxQty,
      arrivalSlot: ri(0, T - 1),
      tiers,
    });
  }
  const demand = ri(1, 10);
  const exclusions: Array<[number, number]> = [];
  const dependencies: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (rand() < 0.15) exclusions.push([i, j]);
    }
    if (n > 1 && rand() < 0.2) {
      const j = ri(0, n - 1);
      if (j !== i) dependencies.push([i, j]);
    }
  }
  return {
    demand,
    cap: demand + ri(0, 5),
    suppliers,
    exclusions,
    dependencies,
    slotCapacity: Array.from({ length: T }, () => ri(0, 12)),
    slotDemand: Array.from({ length: T }, () => ri(0, 5)),
  };
}

test("随机小例：DP 与枚举结果一致", () => {
  const rand = mulberry32(20261006);
  for (let iter = 0; iter < 300; iter++) {
    const p = randomProblem(rand);
    const dp = solveDp(p);
    const en = solveEnumerate(p);
    assert.equal(dp.feasible, en.feasible, `iter=${iter} 可行性不一致`);
    assert.deepEqual(dp.best, en.best, `iter=${iter} 最优解不一致`);
    if (dp.best) {
      for (const s of dp.slots) assert.equal(s.ok, true, `iter=${iter} 时段 ${s.slot} 应无缺货`);
    }
  }
});
