import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import {
  MAX_ORIGINAL_PRICE,
  forwardChain,
  invertChain,
  mergeIntervals,
  parseStep,
  preimageInterval,
  roundHalfEven,
  verifyLowDomain,
  type Interval,
  type RationalStep,
} from "../src/core.js";

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

function bruteForcePreimage(
  step: RationalStep,
  n: bigint,
  xMax: bigint
): bigint[] {
  const hits: bigint[] = [];
  for (let x = 0n; x <= xMax; x++) {
    if (roundHalfEven(x * step.p, step.q) === n) hits.push(x);
  }
  return hits;
}

test("roundHalfEven: 非平局", () => {
  equal(roundHalfEven(9n, 4n), 2n); // 2.25 -> 2
  equal(roundHalfEven(11n, 4n), 3n); // 2.75 -> 3
  equal(roundHalfEven(1n, 3n), 0n); // 0.33 -> 0
  equal(roundHalfEven(2n, 3n), 1n); // 0.67 -> 1
  equal(roundHalfEven(0n, 7n), 0n);
});

test("roundHalfEven: 平局取偶", () => {
  equal(roundHalfEven(1n, 2n), 0n); // 0.5 -> 0
  equal(roundHalfEven(3n, 2n), 2n); // 1.5 -> 2
  equal(roundHalfEven(5n, 2n), 2n); // 2.5 -> 2
  equal(roundHalfEven(7n, 2n), 4n); // 3.5 -> 4
  equal(roundHalfEven(25n, 10n), 2n); // 2.5 -> 2
  equal(roundHalfEven(35n, 10n), 4n); // 3.5 -> 4
  equal(roundHalfEven(45n, 10n), 4n); // 4.5 -> 4
});

test("parseStep: 分数与整数", () => {
  deepEqual(parseStep("3/4"), { p: 3n, q: 4n });
  deepEqual(parseStep(" 9/10 "), { p: 9n, q: 10n });
  deepEqual(parseStep("2"), { p: 2n, q: 1n });
});

test("parseStep: 非法输入", () => {
  for (const bad of ["", "a", "1/0", "0/1", "-1/2", "1.5", "1/2/3"]) {
    let threw = false;
    try {
      parseStep(bad);
    } catch {
      threw = true;
    }
    ok(threw, `应当拒绝: ${bad}`);
  }
});

test("preimageInterval: 与逐值暴力枚举一致（随机单步）", () => {
  const rand = mulberry32(42);
  for (let iter = 0; iter < 300; iter++) {
    const p = BigInt(1 + Math.floor(rand() * 12));
    const q = BigInt(1 + Math.floor(rand() * 12));
    const n = BigInt(Math.floor(rand() * 40));
    const step = { p, q };
    const pre = preimageInterval(step, n, n);
    const hits = bruteForcePreimage(step, n, 1000n);
    if (hits.length === 0) {
      // 暴力窗口内无解时，原像要么为空，要么整体超出窗口
      if (pre !== null) ok(pre[0] > 1000n, `p=${p} q=${q} n=${n}`);
      continue;
    }
    if (pre === null) {
      ok(false, `p=${p} q=${q} n=${n} 应有解`);
      continue;
    }
    const [lo, hi] = pre;
    // 暴力窗口必须完整覆盖 [lo, hi] 与非负定义域的交集
    ok(hi >= 0n && hi <= 1000n, `窗口未覆盖 p=${p} q=${q} n=${n} -> [${lo},${hi}]`);
    const loClamped = lo < 0n ? 0n : lo; // 定义域为 x >= 0，负值部分截去
    equal(hits.length, Number(hi - loClamped + 1n), `连续性 p=${p} q=${q} n=${n}`);
    equal(hits[0], loClamped);
    equal(hits[hits.length - 1], hi);
  }
});

test("invertChain: 随机链（1-8 步）与逐值前向暴力一致", () => {
  const rand = mulberry32(20261008);
  for (let iter = 0; iter < 150; iter++) {
    const nSteps = 1 + Math.floor(rand() * 8);
    const steps: RationalStep[] = [];
    for (let i = 0; i < nSteps; i++) {
      steps.push({
        p: BigInt(1 + Math.floor(rand() * 9)),
        q: BigInt(1 + Math.floor(rand() * 9)),
      });
    }
    const target = BigInt(Math.floor(rand() * 25));
    const domain: [bigint, bigint] = [0n, 2000n];
    const intervals = invertChain(steps, target, domain[0], domain[1]);

    // 区间自身性质：升序、互不交叠、互不相邻、落在定义域内
    for (let i = 0; i < intervals.length; i++) {
      const iv = intervals[i];
      if (iv === undefined) throw new Error("unreachable");
      ok(iv[0] <= iv[1], "闭区间端点有序");
      ok(iv[0] >= domain[0] && iv[1] <= domain[1], "区间在定义域内");
      const prev = intervals[i - 1];
      if (prev !== undefined) {
        ok(iv[0] > prev[1] + 1n, "区间互不交叠且不相邻");
      }
    }

    // 成员判定与暴力前向一致
    const inside = (x: bigint): boolean =>
      intervals.some(([lo, hi]) => lo <= x && x <= hi);
    for (let x = domain[0]; x <= domain[1]; x++) {
      const expect = forwardChain(steps, x) === target;
      equal(
        inside(x),
        expect,
        `x=${x} steps=${steps.map((s) => `${s.p}/${s.q}`).join(",")} target=${target}`
      );
    }
  }
});

test("invertChain: 定义域上界 10^12 截断", () => {
  const intervals = invertChain([{ p: 1n, q: 2n }], 500_000_000_000n);
  deepEqual(intervals, [
    [MAX_ORIGINAL_PRICE - 1n, MAX_ORIGINAL_PRICE],
  ]);
});

test("invertChain: 目标 0 与平局取偶边界", () => {
  // round(x/10)=0 当 x/10 <= 0.5 且平局 0.5 取偶到 0，即 x in [0, 5]
  deepEqual(invertChain([{ p: 1n, q: 10n }], 0n), [[0n, 5n]]);
});

test("invertChain: 无法达到的金额返回空", () => {
  // 翻倍链 round(2x) 恒为偶数，目标 3 无解
  deepEqual(invertChain([{ p: 2n, q: 1n }], 3n), []);
  // 大幅折扣后目标过大无解
  deepEqual(invertChain([{ p: 1n, q: 1000n }], 10n ** 12n), []);
});

test("invertChain: 恒等链", () => {
  deepEqual(invertChain([{ p: 1n, q: 1n }], 777n), [[777n, 777n]]);
});

test("invertChain: 步数限制", () => {
  const nineSteps: RationalStep[] = Array.from({ length: 9 }, () => ({
    p: 1n,
    q: 1n,
  }));
  let threw = false;
  try {
    invertChain(nineSteps, 1n);
  } catch {
    threw = true;
  }
  ok(threw, "9 步应当被拒绝");
});

test("invertChain: 8 步链低价域逐值核验通过", () => {
  const steps: RationalStep[] = [
    { p: 9n, q: 10n },
    { p: 4n, q: 5n },
    { p: 7n, q: 8n },
    { p: 1n, q: 2n },
    { p: 5n, q: 6n },
    { p: 3n, q: 4n },
    { p: 2n, q: 3n },
    { p: 9n, q: 10n },
  ];
  const target = 12n;
  const intervals = invertChain(steps, target, 0n, 100_000n);
  ok(intervals.length > 0, "应当有解");
  const report = verifyLowDomain(steps, target, intervals, 100_000n, 0n, 100_000n);
  equal(report.truncated, false);
  deepEqual(report.mismatches, []);
  deepEqual(report.boundaryErrors, []);
  ok(report.checked > 0n);
});

test("mergeIntervals: 合并交叠与相邻区间", () => {
  const merged = mergeIntervals([
    [10n, 12n],
    [1n, 3n],
    [4n, 6n],
    [20n, 22n],
    [13n, 15n],
  ]);
  deepEqual(merged, [
    [1n, 6n],
    [10n, 15n],
    [20n, 22n],
  ]);
});

test("verifyLowDomain: 能发现被篡改的区间", () => {
  const steps: RationalStep[] = [{ p: 1n, q: 2n }];
  const target = 10n;
  const good = invertChain(steps, target, 0n, 1000n);
  // 9.5 与 10.5 均为平局且取偶到 10，故 x in {19, 20, 21}
  deepEqual(good, [[19n, 21n]]);
  const report = verifyLowDomain(steps, target, good, 1000n, 0n, 1000n);
  deepEqual(report.mismatches, []);
  deepEqual(report.boundaryErrors, []);
  // 人为把区间扩大 1，核验应报错
  const bad: Interval[] = [[19n, 22n]];
  const badReport = verifyLowDomain(steps, target, bad, 1000n, 0n, 1000n);
  ok(badReport.mismatches.length > 0 || badReport.boundaryErrors.length > 0);
});
