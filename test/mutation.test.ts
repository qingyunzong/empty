import test from "node:test";
import assert from "node:assert/strict";
import { SignalSeries, directWindowAverage } from "../src/signal.js";
import type { Cell } from "../src/types.js";

const base: Cell[] = [
  { value: 5, weight: 1 },
  { value: 7, weight: 2 },
  { value: 9, weight: 1 },
  { value: 11, weight: 3 },
  { value: 13, weight: 1 },
  null,
  { value: 15, weight: 2 },
];

function assertMatchesDirect(s: SignalSeries, ks: number[]): void {
  const snap = s.snapshot();
  for (let end = 0; end < s.length; end++) {
    for (const k of ks) {
      assert.deepEqual(
        s.windowAverage(end, k),
        directWindowAverage(snap, end, k),
        `end=${end} k=${k}`,
      );
    }
  }
}

test("更正样本后与直接分数计算一致", () => {
  const s = new SignalSeries(3, base);
  s.correct(3, { value: 100, weight: 5 });
  assertMatchesDirect(s, [1, 2, 3, 4]);
  s.correct(0, { value: 1, weight: 0 });
  assertMatchesDirect(s, [1, 2, 3, 4]);
});

test("删除样本改变相邻权重", () => {
  const s = new SignalSeries(3, base);
  const before1 = s.effectiveWeightAt(1);
  const before3 = s.effectiveWeightAt(3);
  s.delete(2);
  assert.notEqual(s.effectiveWeightAt(1), before1); // 后方缺测距离 3→1
  assert.notEqual(s.effectiveWeightAt(3), before3); // 前方缺测距离 3→1
  assert.equal(s.effectiveWeightAt(2), 0); // 删除位置变为缺失
  assert.equal(s.at(2), null); // 仍占时间位置
  assert.equal(s.length, base.length);
  assertMatchesDirect(s, [1, 2, 3, 4]);
});

test("删除样本改变后续窗口成员", () => {
  const s = new SignalSeries(4, base);
  const before = s.windowAverage(6, 4)!;
  assert.equal(before.from, 2); // 成员 t6,t4,t3,t2（t5 缺测）
  s.delete(2);
  const after = s.windowAverage(6, 4)!;
  assert.equal(after.from, 1); // 成员变为 t6,t4,t3,t1
  assert.equal(after.count, 4);
  assertMatchesDirect(s, [4]);
});

test("确定性随机操作序列下增量结果始终与直接计算一致", () => {
  let seed = 0x2f6e2b1;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  const s = new SignalSeries(3, []);
  const pool: Cell[] = [
    { value: 3, weight: 0 },
    { value: 4, weight: 1 },
    { value: 8, weight: 2 },
    { value: 6, weight: 5 },
    null,
  ];
  const samples = pool.filter((c): c is NonNullable<Cell> => c !== null);
  for (let op = 0; op < 300; op++) {
    const r = rand() % 10;
    if (s.length === 0 || r < 4) {
      s.append(pool[rand() % pool.length]);
    } else if (r < 7) {
      s.correct(rand() % s.length, samples[rand() % samples.length]);
    } else {
      s.delete(rand() % s.length);
    }
    if (op % 7 === 0) assertMatchesDirect(s, [1, 3, 5]);
  }
  assertMatchesDirect(s, [1, 2, 3, 4, 5]);
});
