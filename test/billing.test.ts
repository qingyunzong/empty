import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  billByGrid,
  billBySegments,
  ceilMinutes,
  compareWithGrid,
  gridMinutes,
} from "../src/billing.js";

test("分段计费：并集后与费率求交，每段向上计分钟乘费率", () => {
  const bill = billBySegments(
    [
      { start: 0, end: 100 },
      { start: 50, end: 150 }, // 与上一段重叠，并集成 [0,150)
    ],
    [
      { start: 0, end: 120, ratePerMinuteCents: 10 },
      { start: 120, end: 1000, ratePerMinuteCents: 20 },
    ],
  );
  assert.deepEqual(bill.mergedOnline, [{ start: 0, end: 150 }]);
  assert.equal(bill.segments.length, 2);

  const [s0, s1] = bill.segments;
  // [0,120)：120 秒 → 2 分钟 × 10 分
  assert.deepEqual(
    [s0!.start, s0!.end, s0!.seconds, s0!.billedMinutes, s0!.feeCents],
    [0, 120, 120, 2, 20],
  );
  // [120,150)：30 秒 → 向上 1 分钟 × 20 分
  assert.deepEqual(
    [s1!.start, s1!.end, s1!.seconds, s1!.billedMinutes, s1!.feeCents],
    [120, 150, 30, 1, 20],
  );
  assert.equal(bill.totalFeeCents, 40);
});

test("来源段：记录合并后上线区间与费率区间下标", () => {
  const bill = billBySegments(
    [
      { start: 0, end: 30 },
      { start: 1000, end: 1030 },
    ],
    [{ start: 0, end: 2000, ratePerMinuteCents: 5 }],
  );
  assert.equal(bill.segments.length, 2);
  assert.equal(bill.segments[0]!.sourceOnlineIndex, 0);
  assert.equal(bill.segments[1]!.sourceOnlineIndex, 1);
  assert.equal(bill.segments[0]!.sourceRateIndex, 0);
  assert.equal(bill.segments[1]!.sourceRateIndex, 0);
});

test("ceil/grid 基本性质", () => {
  assert.equal(ceilMinutes(0), 0);
  assert.equal(ceilMinutes(1), 1);
  assert.equal(ceilMinutes(60), 1);
  assert.equal(ceilMinutes(61), 2);
  assert.equal(gridMinutes(0, 60), 1);
  assert.equal(gridMinutes(1, 61), 2); // 跨两个网格
  assert.equal(gridMinutes(30, 90), 2);
  assert.equal(gridMinutes(0, 0), 0);
});

test("网格对照：网格对齐时两模型一致", () => {
  const online = [
    { start: 0, end: 120 },
    { start: 180, end: 300 },
  ];
  const rates = [{ start: 0, end: 600, ratePerMinuteCents: 7 }];
  const seg = billBySegments(online, rates);
  const grid = billByGrid(online, rates);
  const cmp = compareWithGrid(seg, grid);
  assert.equal(cmp.equal, true);
  assert.equal(cmp.segmentTotalCents, 4 * 7);
  assert.equal(cmp.gridTotalCents, 4 * 7);
});

test("网格对照：错位时分段模型可能多计，差异被报告", () => {
  // 上线 [50, 70)：20 秒。分段模型 ceil(20/60)=1 分钟；
  // 网格模型覆盖网格 [0,60) 与 [60,120) 共 2 分钟 → 网格反而多计。
  const online = [{ start: 50, end: 70 }];
  const rates = [{ start: 0, end: 600, ratePerMinuteCents: 10 }];
  const cmp = compareWithGrid(billBySegments(online, rates), billByGrid(online, rates));
  assert.equal(cmp.segmentTotalCents, 10);
  assert.equal(cmp.gridTotalCents, 20);
  assert.equal(cmp.diffCents, -10);
  assert.equal(cmp.equal, false);
});

test("费率区间重叠被拒绝", () => {
  assert.throws(() =>
    billBySegments(
      [{ start: 0, end: 10 }],
      [
        { start: 0, end: 100, ratePerMinuteCents: 1 },
        { start: 50, end: 150, ratePerMinuteCents: 2 },
      ],
    ),
  );
});
