import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RateInterval,
  buildSegments,
  ceilMinutes,
  gridSegmentFeeCents,
  gridTotalFeeCents,
  totalFeeCents,
} from "../src/billing.js";
import { computeBill, correctBill, publishBill } from "../src/engine.js";
import { Ledger } from "../src/ledger.js";

const rates: RateInterval[] = [
  { start: 0, end: 3600, rateCentsPerMin: 2 },
  { start: 3600, end: 7200, rateCentsPerMin: 5 },
];

test("向上计分钟：61 秒计 2 分钟，60 秒计 1 分钟，0 秒计 0", () => {
  assert.equal(ceilMinutes(61), 2);
  assert.equal(ceilMinutes(60), 1);
  assert.equal(ceilMinutes(1), 1);
  assert.equal(ceilMinutes(0), 0);
});

test("上线区间先求并集再与费率区间求交", () => {
  // [10,130) 与 [100,3700) 重叠，并集为 [10,3700)，跨两个费率区间。
  const segments = buildSegments(
    [
      { start: 10, end: 130 },
      { start: 100, end: 3700 },
    ],
    rates,
  );
  assert.deepEqual(
    segments.map((s) => [s.start, s.end, s.rateCentsPerMin, s.minutes, s.feeCents]),
    [
      [10, 3600, 2, 60, 120], // 3590 秒 -> 60 分钟
      [3600, 3700, 5, 2, 10], // 100 秒 -> 2 分钟
    ],
  );
  assert.equal(totalFeeCents(segments), 130);
});

test("重叠上线区间合并后只计一次费", () => {
  const segments = buildSegments(
    [
      { start: 0, end: 100 },
      { start: 50, end: 150 },
      { start: 90, end: 120 },
    ],
    [{ start: 0, end: 1000, rateCentsPerMin: 3 }],
  );
  assert.equal(segments.length, 1);
  assert.equal(segments[0]!.feeCents, ceilMinutes(150) * 3);
});

test("费率区间重叠时抛错", () => {
  assert.throws(() =>
    buildSegments(
      [{ start: 0, end: 10 }],
      [
        { start: 0, end: 100, rateCentsPerMin: 1 },
        { start: 50, end: 150, rateCentsPerMin: 2 },
      ],
    ),
  );
});

test("网格计时模型对照：随机用例公式法与逐秒模拟一致", () => {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let round = 0; round < 200; round++) {
    const online = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => {
      const start = Math.floor(rand() * 2000);
      return { start, end: start + 1 + Math.floor(rand() * 800) };
    });
    const rateCuts = [0, 500 + Math.floor(rand() * 500), 3000];
    const randomRates: RateInterval[] = [
      { start: rateCuts[0]!, end: rateCuts[1]!, rateCentsPerMin: Math.floor(rand() * 5) },
      { start: rateCuts[1]!, end: rateCuts[2]!, rateCentsPerMin: Math.floor(rand() * 5) },
    ];
    const segments = buildSegments(online, randomRates);
    assert.equal(
      totalFeeCents(segments),
      gridTotalFeeCents(segments),
      `第 ${round} 轮: ${JSON.stringify({ online, randomRates })}`,
    );
    for (const s of segments) {
      assert.equal(
        s.feeCents,
        gridSegmentFeeCents(s.start, s.end, s.rateCentsPerMin),
      );
    }
  }
});

test("更正后与网格计时模型对照", () => {
  const users = [
    { userId: "alice", online: [{ start: 10, end: 130 }, { start: 100, end: 3700 }] },
    { userId: "bob", online: [{ start: 60, end: 180 }] },
  ];
  const ledger = new Ledger();
  const original = computeBill("B1", users, rates);
  publishBill(ledger, original);

  const correctedUsers = [
    { userId: "alice", online: [{ start: 10, end: 130 }, { start: 100, end: 300 }] },
    { userId: "bob", online: [{ start: 60, end: 180 }] },
  ];
  const corrected = correctBill(ledger, original, "B1-C1", correctedUsers, rates);

  const segments = corrected.lines.map((l) => l.segment);
  assert.equal(corrected.totalCents, gridTotalFeeCents(segments));
  // 更正后 alice 的在线并集为 [10,300)，与费率 [0,3600)@2 相交 -> 290 秒 -> 5 分钟 -> 10 分。
  assert.equal(corrected.totalCents, 10);
});
