import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  assertConservation,
  settleAccount,
  settleSegment,
} from "../src/settlement.js";

test("按比例分账：向下取分后余分按精确余数分配", () => {
  // 100 分按 1:1:1 秒分：每人 33.33…，向下各 33，余 1 分。
  // 精确余数相同 → 按用户 ID 升序，alice 多得 1 分。
  const shares = settleSegment(100, [
    { userId: "carol", seconds: 10 },
    { userId: "alice", seconds: 10 },
    { userId: "bob", seconds: 10 },
  ]);
  const byUser = new Map(shares.map((s) => [s.userId, s.shareCents]));
  assert.equal(byUser.get("alice"), 34);
  assert.equal(byUser.get("bob"), 33);
  assert.equal(byUser.get("carol"), 33);
  assertConservation(100, shares);
});

test("余分按精确余数降序，余数大的优先", () => {
  // 10 分按 3:5:2 秒（总 10）：精确份额 3、5、2 → 无余分。
  const exact = settleSegment(10, [
    { userId: "a", seconds: 3 },
    { userId: "b", seconds: 5 },
    { userId: "c", seconds: 2 },
  ]);
  assert.deepEqual(
    exact.map((s) => [s.userId, s.shareCents]),
    [
      ["a", 3],
      ["b", 5],
      ["c", 2],
    ],
  );

  // 10 分按 1:1:2 秒（总 4）：精确 2.5、2.5、5 → 向下 2、2、5，余 1 分；
  // a、b 余数并列 → ID 升序，a 得余分。
  const tied = settleSegment(10, [
    { userId: "b", seconds: 1 },
    { userId: "a", seconds: 1 },
    { userId: "c", seconds: 2 },
  ]);
  const byUser = new Map(tied.map((s) => [s.userId, s.shareCents]));
  assert.equal(byUser.get("a"), 3);
  assert.equal(byUser.get("b"), 2);
  assert.equal(byUser.get("c"), 5);
});

test("边界：零费用、零占用、非法输入", () => {
  const zero = settleSegment(0, [{ userId: "a", seconds: 5 }]);
  assert.equal(zero[0]!.shareCents, 0);
  assert.deepEqual(
    settleSegment(0, [{ userId: "a", seconds: 0 }])[0]!.shareCents,
    0,
  );
  assert.throws(() => settleSegment(1, [{ userId: "a", seconds: 0 }]));
  assert.throws(() => settleSegment(-1, [{ userId: "a", seconds: 1 }]));
  assert.throws(() =>
    settleSegment(1, [
      { userId: "a", seconds: 1 },
      { userId: "a", seconds: 2 },
    ]),
  );
});

test("全账清算：逐段守恒且全账守恒", () => {
  const result = settleAccount([
    {
      segmentId: "s0",
      feeCents: 101,
      occupations: [
        { userId: "a", seconds: 7 },
        { userId: "b", seconds: 3 },
      ],
    },
    {
      segmentId: "s1",
      feeCents: 55,
      occupations: [
        { userId: "a", seconds: 1 },
        { userId: "c", seconds: 2 },
      ],
    },
  ]);
  assert.equal(result.totalFeeCents, 156);
  const userSum = [...result.perUserTotals.values()].reduce((x, y) => x + y, 0);
  assert.equal(userSum, 156);
  for (const seg of result.perSegment) {
    assert.equal(
      seg.shares.reduce((s, x) => s + x.shareCents, 0),
      seg.feeCents,
      `段 ${seg.segmentId} 不守恒`,
    );
  }
});

test("小分账枚举核对：穷举小额费用与占用，验证守恒与分配规则", () => {
  // 枚举：费用 0..47 分，1..4 个用户，每户占用 0..5 秒（总占用 > 0）。
  // 对每例独立重算期望结果并逐项核对。
  let cases = 0;
  for (let fee = 0; fee <= 47; fee++) {
    for (let n = 1; n <= 4; n++) {
      const maxSec = 5;
      const totalCombos = Math.pow(maxSec + 1, n);
      for (let combo = 0; combo < totalCombos; combo++) {
        const secs: number[] = [];
        let x = combo;
        for (let i = 0; i < n; i++) {
          secs.push(x % (maxSec + 1));
          x = Math.floor(x / (maxSec + 1));
        }
        const totalSec = secs.reduce((a, b) => a + b, 0);
        if (totalSec === 0) continue;

        const occ = secs.map((s, i) => ({ userId: `u${i}`, seconds: s }));
        const shares = settleSegment(fee, occ);
        cases++;

        // 1) 守恒
        assert.equal(
          shares.reduce((s, x) => s + x.shareCents, 0),
          fee,
          `不守恒 fee=${fee} secs=${secs}`,
        );

        // 2) 每户份额 ∈ {⌊精确值⌋, ⌊精确值⌋+1}
        for (let i = 0; i < n; i++) {
          const exact = (fee * secs[i]!) / totalSec;
          const floor = Math.floor(exact);
          const got = shares[i]!.shareCents;
          assert.ok(
            got === floor || got === floor + 1,
            `份额越界 fee=${fee} secs=${secs} user=u${i} got=${got} floor=${floor}`,
          );
        }

        // 3) 余分分配顺序：精确余数降序、ID 升序（用 BigInt 独立重算）
        const feeB = BigInt(fee);
        const totalB = BigInt(totalSec);
        const expect = secs.map((s, i) => {
          const num = feeB * BigInt(s);
          const floor = num / totalB;
          return { i, floor, frac: num - floor * totalB, userId: `u${i}` };
        });
        let remainder = fee - expect.reduce((s, e) => s + Number(e.floor), 0);
        const order = [...expect].sort((a, b) =>
          a.frac !== b.frac
            ? a.frac > b.frac
              ? -1
              : 1
            : a.userId < b.userId
              ? -1
              : 1,
        );
        const bonus = new Array<number>(n).fill(0);
        for (const { i } of order) {
          if (remainder <= 0) break;
          bonus[i] = 1;
          remainder--;
        }
        for (let i = 0; i < n; i++) {
          assert.equal(
            shares[i]!.shareCents,
            Number(expect[i]!.floor) + bonus[i]!,
            `分配不符 fee=${fee} secs=${secs} user=u${i}`,
          );
        }
      }
    }
  }
  // 记录枚举规模，防止用例被意外裁剪
  assert.equal(cases, 48 * (5 + 35 + 215 + 1295));
});
