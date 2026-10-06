import { test } from "node:test";
import { equal, deepEqual, ok, throws } from "node:assert/strict";
import { frac, parseFraction, add, mul, cmp, formatFraction, type Fraction } from "../src/fraction.js";
import { solve, type Liquid, type Solution } from "../src/solver.js";

const L = (c: string, cost: number): Liquid => ({ concentration: parseFraction(c), cost: BigInt(cost) });

function must(s: Solution | null, ctx = "应有解"): Solution {
  if (s === null) throw new Error(ctx);
  return s;
}

/** 暴力枚举全部向量（Σx <= maxTotal），作为小域参照实现。 */
function bruteForce(
  liquids: Liquid[],
  lo: Fraction,
  hi: Fraction,
  maxTotal: number,
): { amounts: number[]; cost: bigint } | null {
  const n = liquids.length;
  const x = new Array<number>(n).fill(0);
  let best: { amounts: number[]; cost: bigint } | null = null;
  const rec = (i: number, rem: number, cost: bigint, used: number, sumC: Fraction): void => {
    if (used > 0) {
      const u = frac(BigInt(used));
      if (cmp(sumC, mul(lo, u)) >= 0 && cmp(sumC, mul(hi, u)) <= 0) {
        // 枚举顺序即字典序升序，同成本先遇到的就是字典序最小。
        if (best === null || cost < best.cost) best = { amounts: [...x], cost };
      }
    }
    if (i === n || rem === 0) return;
    for (let k = 0; k <= rem; k++) {
      x[i] = k;
      rec(
        i + 1,
        rem - k,
        cost + liquids[i].cost * BigInt(k),
        used + k,
        add(sumC, mul(liquids[i].concentration, frac(BigInt(k)))),
      );
    }
    x[i] = 0;
  };
  rec(0, maxTotal, 0n, 0, frac(0n));
  return best;
}

function checkValid(s: Solution, liquids: Liquid[], lo: Fraction, hi: Fraction, maxTotal: number): void {
  ok(s.total >= 1 && s.total <= maxTotal, "总量在界内");
  equal(s.amounts.reduce((a, b) => a + b, 0), s.total);
  ok(s.amounts.every((a) => Number.isInteger(a) && a >= 0), "用量为非负整数");
  ok(cmp(s.concentration, lo) >= 0 && cmp(s.concentration, hi) <= 0, "浓度落在闭区间");
  let cost = 0n;
  let conc = frac(0n);
  for (let i = 0; i < liquids.length; i++) {
    cost += liquids[i].cost * BigInt(s.amounts[i]);
    conc = add(conc, mul(liquids[i].concentration, frac(BigInt(s.amounts[i]))));
  }
  equal(s.cost, cost);
  equal(formatFraction(s.concentration), formatFraction(mul(conc, frac(1n, BigInt(s.total)))));
}

test("手算用例：成本优先，再字典序", () => {
  // c = 1/2 (成本 3)、c = 1/4 (成本 1)，目标 [1/3, 2/5]。
  // 单用液体0：1/2 超界；单用液体1：1/4 不足。需混合。
  // x0=1,x1=1 -> 3/8 ∈ [1/3,2/5]，成本 4；x0=1,x1=2 -> 1/3，成本 5。
  // 成本最小为 4，向量 (1,1)。
  const s = must(solve([L("1/2", 3), L("1/4", 1)], parseFraction("1/3"), parseFraction("2/5"), 40));
  deepEqual(s.amounts, [1, 1]);
  equal(s.cost, 4n);
  equal(formatFraction(s.concentration), "3/8");
});

test("字典序并列：同成本取靠前分量更小的向量", () => {
  // 两种液体浓度 0 与 1，成本均为 0，目标恰为 1/2 -> 需 x0 = x1，字典序最小为 (1,1)。
  const s = must(solve([L("0", 0), L("1", 0)], parseFraction("1/2"), parseFraction("1/2"), 40));
  deepEqual(s.amounts, [1, 1]);
  equal(s.cost, 0n);
  equal(formatFraction(s.concentration), "1/2");
});

test("无解：所有浓度都在区间之外", () => {
  const s = solve([L("1/2", 1), L("3/4", 2)], parseFraction("1/8"), parseFraction("1/4"), 40);
  equal(s, null);
});

test("无解：单种液体浓度恒为 1/3，达不到单点 1/2", () => {
  const s = solve([L("1/3", 1)], parseFraction("1/2"), parseFraction("1/2"), 40);
  equal(s, null);
});

test("参数校验", () => {
  const one = [L("1/2", 1)];
  const lo = parseFraction("1/3");
  const hi = parseFraction("1/2");
  throws(() => solve([], lo, hi, 40)); // 0 种液体
  throws(() => solve(Array.from({ length: 13 }, () => L("1/2", 1)), lo, hi, 40)); // 13 种
  throws(() => solve(one, lo, hi, 0)); // 总量上限 0
  throws(() => solve(one, lo, hi, 41)); // 总量上限 41
  throws(() => solve(one, hi, lo, 40)); // 区间下界 > 上界
  throws(() => solve([L("1/2", -1)], lo, hi, 40)); // 负成本
});

test("小域全向量核验：随机实例 vs 暴力枚举", () => {
  // 确定性 PRNG，保证可复现。
  let seed = 0x9e3779b9;
  const rnd = (): number => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pool = ["0", "1/4", "1/3", "1/2", "2/3", "3/4", "1"];
  const cases = 400;
  for (let t = 0; t < cases; t++) {
    const n = 1 + Math.floor(rnd() * 4); // 1..4 种
    const maxTotal = 1 + Math.floor(rnd() * 7); // 1..7
    const liquids = Array.from({ length: n }, () =>
      L(pool[Math.floor(rnd() * pool.length)], Math.floor(rnd() * 5)),
    );
    let lo = parseFraction(pool[Math.floor(rnd() * pool.length)]);
    let hi = parseFraction(pool[Math.floor(rnd() * pool.length)]);
    if (cmp(lo, hi) > 0) [lo, hi] = [hi, lo];
    const got = solve(liquids, lo, hi, maxTotal);
    const want = bruteForce(liquids, lo, hi, maxTotal);
    const ctx = `case ${t}: n=${n} maxTotal=${maxTotal} liquids=${liquids
      .map((l) => `${formatFraction(l.concentration)}@${l.cost}`)
      .join(",")} target=[${formatFraction(lo)},${formatFraction(hi)}]`;
    if (want === null) {
      ok(got === null, `应为无解: ${ctx}`);
    } else {
      const g = must(got, `应有解: ${ctx}`);
      equal(g.cost, want.cost, `成本一致: ${ctx}`);
      deepEqual(g.amounts, want.amounts, `向量一致: ${ctx}`);
      checkValid(g, liquids, lo, hi, maxTotal);
    }
  }
});

test("满规模：12 种液体、总量 40，在合理时间内完成", () => {
  const liquids = [
    L("1/8", 7), L("1/5", 5), L("1/4", 4), L("3/10", 6),
    L("1/3", 3), L("2/5", 2), L("1/2", 9), L("11/20", 1),
    L("3/5", 8), L("2/3", 4), L("7/10", 6), L("4/5", 5),
  ];
  const lo = parseFraction("7/20");
  const hi = parseFraction("2/5");
  const start = Date.now();
  const s = must(solve(liquids, lo, hi, 40), "满规模实例有解");
  const elapsed = Date.now() - start;
  checkValid(s, liquids, lo, hi, 40);
  ok(elapsed < 10000, `耗时 ${elapsed}ms 应小于 10s`);
});

test("满规模无解也能完备搜索返回 null", () => {
  const liquids = [
    L("1/8", 7), L("1/5", 5), L("1/4", 4), L("3/10", 6),
    L("1/3", 3), L("2/5", 2), L("1/2", 9), L("11/20", 1),
    L("3/5", 8), L("2/3", 4), L("7/10", 6), L("4/5", 5),
  ];
  // 区间落在所有浓度之外。
  const s = solve(liquids, parseFraction("9/10"), parseFraction("19/20"), 40);
  equal(s, null);
});
