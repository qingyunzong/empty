import { test } from "node:test";
import assert from "node:assert/strict";
import { split, SplitError, type Recipient } from "../src/split.js";
import {
  bruteForce,
  canonical,
  dpSolve,
  exactCost,
  mulberry32,
  randomInstance,
  randInt,
  sum,
} from "./helpers.js";

/** 用 split() 求解并按 ID 升序对齐，便于与核对器比较。 */
function solveAligned(
  total: number,
  recipients: readonly Recipient[],
): { alloc: number[]; cost: bigint } {
  const out = split(total, recipients);
  const norm = canonical(recipients);
  const alloc = norm.map((r) => out.get(r.id)!);
  return { alloc, cost: exactCost(alloc, norm, total) };
}

function assertConsistent(
  total: number,
  recipients: readonly Recipient[],
  expected: { cost: bigint; alloc: number[] } | null,
  context: string,
): void {
  const norm = canonical(recipients);
  const minSum = sum(norm.map((r) => r.min));
  const maxSum = sum(norm.map((r) => r.max));
  if (expected === null) {
    assert.ok(minSum > total || maxSum < total, `${context}: 枚举器误判可行性`);
    assert.throws(() => split(total, recipients), SplitError, context);
    return;
  }
  const got = solveAligned(total, recipients);
  assert.equal(sum(got.alloc), total, `${context}: 守恒性（总额）`);
  norm.forEach((r, i) => {
    assert.ok(
      got.alloc[i]! >= r.min && got.alloc[i]! <= r.max,
      `${context}: ${r.id} 越界 ${got.alloc[i]} not in [${r.min}, ${r.max}]`,
    );
  });
  assert.equal(got.cost, expected.cost, `${context}: 偏差非最小`);
  assert.deepEqual(
    got.alloc,
    expected.alloc,
    `${context}: 并列时未按 ID 字典序最大`,
  );
}

test("小金额全枚举：2 人全参数网格 vs 暴力枚举", () => {
  const weights = [0, 1, 2].flatMap((num) =>
    [1, 2, 3].map((den) => ({ num, den })),
  );
  let checked = 0;
  for (const w0 of weights) {
    for (const w1 of weights) {
      for (let min0 = 0; min0 <= 2; min0++) {
        for (let min1 = 0; min1 <= 2; min1++) {
          for (let cap0 = 0; cap0 <= 3; cap0++) {
            for (let cap1 = 0; cap1 <= 3; cap1++) {
              const recipients: Recipient[] = [
                { id: "a", weight: w0, min: min0, max: min0 + cap0 },
                { id: "b", weight: w1, min: min1, max: min1 + cap1 },
              ];
              for (let total = 0; total <= 10; total++) {
                const expected = bruteForce(total, recipients);
                assertConsistent(
                  total,
                  recipients,
                  expected,
                  `grid w=${JSON.stringify([w0, w1])} min=${min0},${min1} cap=${cap0},${cap1} T=${total}`,
                );
                checked++;
              }
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 50000, `覆盖量不足: ${checked}`);
  console.log(`2 人网格共核对 ${checked} 个实例`);
});

test("小金额全枚举：3-4 人随机实例 vs 暴力枚举", () => {
  const rng = mulberry32(20261005);
  for (let k = 0; k < 4000; k++) {
    const n = randInt(rng, 3, 4);
    const { total, recipients } = randomInstance(rng, n, 14);
    const expected = bruteForce(total, recipients);
    assertConsistent(total, recipients, expected, `random#${k} n=${n} T=${total}`);
  }
  console.log("3-4 人随机实例共核对 4000 个");
});

test("全分配枚举（DP）：最多 8 人、总额 100 分，核对最优与守恒", () => {
  const rng = mulberry32(100000007);
  let checked = 0;
  for (let k = 0; k < 600; k++) {
    const n = randInt(rng, 5, 8);
    const { recipients } = randomInstance(rng, n, 100);
    const minSum = sum(recipients.map((r) => r.min));
    const maxSum = sum(recipients.map((r) => r.max));
    if (minSum > 100 || maxSum < 100) continue; // 只要可行实例
    const expected = dpSolve(100, recipients);
    assertConsistent(100, recipients, expected, `dp100#${k} n=${n}`);
    checked++;
  }
  console.log(`8 人/100 分 DP 共核对 ${checked} 个实例`);
});

test("全分配枚举（DP）：随机总额 0..100、1..8 人", () => {
  const rng = mulberry32(424242);
  for (let k = 0; k < 800; k++) {
    const n = randInt(rng, 1, 8);
    const { total, recipients } = randomInstance(rng, n, 100);
    const expected = dpSolve(total, recipients);
    assertConsistent(total, recipients, expected, `dp#${k} n=${n} T=${total}`);
  }
  console.log("随机总额 DP 共核对 800 个实例");
});

test("不可行实例与枚举器一致地报错", () => {
  const rng = mulberry32(777);
  let infeasible = 0;
  for (let k = 0; k < 2000; k++) {
    const n = randInt(rng, 1, 6);
    const { total, recipients } = randomInstance(rng, n, 30);
    // 故意破坏可行性：随机抬高下限或压低上限。
    const mutated = recipients.map((r) => ({ ...r }));
    const pick = randInt(rng, 0, n - 1);
    if (rng() < 0.5) {
      mutated[pick]!.min = total + randInt(rng, 1, 5);
      mutated[pick]!.max = Math.max(mutated[pick]!.max, mutated[pick]!.min);
    } else {
      mutated[pick]!.max = mutated[pick]!.min;
      mutated[pick]!.min = 0;
      const maxSum = sum(mutated.map((r) => r.max));
      if (maxSum >= total) continue;
    }
    const expected = bruteForce(total, mutated);
    if (expected === null) {
      infeasible++;
      assert.throws(() => split(total, mutated), SplitError);
    } else {
      assertConsistent(total, mutated, expected, `mutated#${k}`);
    }
  }
  assert.ok(infeasible > 100, `不可行样本过少: ${infeasible}`);
});
