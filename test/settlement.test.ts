import { test } from "node:test";
import assert from "node:assert/strict";
import { Usage, splitBySeconds } from "../src/settlement.js";

test("整除时按比例精确分配", () => {
  const shares = splitBySeconds(100, [
    { userId: "a", seconds: 1 },
    { userId: "b", seconds: 3 },
  ]);
  assert.deepEqual(shares, [
    { userId: "a", seconds: 1, amountCents: 25 },
    { userId: "b", seconds: 3, amountCents: 75 },
  ]);
});

test("向下取分，余分按精确余数分配", () => {
  // 10 分按 1:1:1 分 -> floor 各 3，余 1 分；余数都是 1/3，按 ID 升序给 a。
  const shares = splitBySeconds(10, [
    { userId: "c", seconds: 1 },
    { userId: "a", seconds: 1 },
    { userId: "b", seconds: 1 },
  ]);
  const byId = new Map(shares.map((s) => [s.userId, s.amountCents]));
  assert.equal(byId.get("a"), 4);
  assert.equal(byId.get("b"), 3);
  assert.equal(byId.get("c"), 3);
});

test("余数不同优先按余数降序", () => {
  // 7 分按 1:2 分：a 精确 7/3=2+1/3，b 精确 14/3=4+2/3 -> b 拿余分。
  const shares = splitBySeconds(7, [
    { userId: "a", seconds: 1 },
    { userId: "b", seconds: 2 },
  ]);
  const byId = new Map(shares.map((s) => [s.userId, s.amountCents]));
  assert.equal(byId.get("a"), 2);
  assert.equal(byId.get("b"), 5);
});

test("零占用用户不得分账", () => {
  const shares = splitBySeconds(10, [
    { userId: "a", seconds: 0 },
    { userId: "b", seconds: 5 },
  ]);
  const byId = new Map(shares.map((s) => [s.userId, s.amountCents]));
  assert.equal(byId.get("a"), 0);
  assert.equal(byId.get("b"), 10);
});

test("总秒数为零且总额为零", () => {
  assert.deepEqual(splitBySeconds(0, [{ userId: "a", seconds: 0 }]), [
    { userId: "a", seconds: 0, amountCents: 0 },
  ]);
  assert.throws(() => splitBySeconds(5, [{ userId: "a", seconds: 0 }]));
});

test("小分账枚举核对：所有小额组合均守恒且分配规则正确", () => {
  // 枚举：总额 0..40 分，1..4 个用户，每人占用 0..6 秒。
  const userIds = ["a", "b", "c", "d"];
  let checked = 0;

  function verify(totalCents: number, usage: Usage[]): void {
    const totalSeconds = usage.reduce((s, u) => s + u.seconds, 0);
    if (totalSeconds === 0) return;
    const shares = splitBySeconds(totalCents, usage);

    // 1) 守恒
    assert.equal(
      shares.reduce((s, x) => s + x.amountCents, 0),
      totalCents,
      `不守恒: total=${totalCents} usage=${JSON.stringify(usage)}`,
    );

    // 2) 每份为 floor 或 floor+1，且余分发给 (精确余数 desc, userId asc) 的头部
    const denom = BigInt(totalSeconds);
    const total = BigInt(totalCents);
    const exact = usage.map((u) => {
      const numerator = total * BigInt(u.seconds);
      return {
        userId: u.userId,
        floor: Number(numerator / denom),
        remainder: numerator % denom,
      };
    });
    const floors = exact.reduce((s, e) => s + e.floor, 0);
    const leftover = totalCents - floors;
    const expectedBonus = new Set(
      [...exact]
        .sort((x, y) => {
          if (x.remainder !== y.remainder) return x.remainder > y.remainder ? -1 : 1;
          return x.userId < y.userId ? -1 : 1;
        })
        .slice(0, leftover)
        .map((e) => e.userId),
    );
    for (const share of shares) {
      const e = exact.find((x) => x.userId === share.userId)!;
      const want = e.floor + (expectedBonus.has(share.userId) ? 1 : 0);
      assert.equal(
        share.amountCents,
        want,
        `分配错误: total=${totalCents} usage=${JSON.stringify(usage)} user=${share.userId}`,
      );
    }
    checked++;
  }

  function enumerateUsers(totalCents: number, depth: number, acc: Usage[]): void {
    if (depth === 0) {
      verify(totalCents, acc);
      return;
    }
    const userId = userIds[acc.length]!;
    for (let seconds = 0; seconds <= 6; seconds++) {
      enumerateUsers(totalCents, depth - 1, [...acc, { userId, seconds }]);
    }
  }

  for (let totalCents = 0; totalCents <= 40; totalCents++) {
    for (let n = 1; n <= 4; n++) {
      enumerateUsers(totalCents, n, []);
    }
  }
  // 41 * (7 + 49 + 343 + 2401) = 114800 个组合全部核对通过。
  assert.equal(checked, 41 * (7 + 49 + 343 + 2401) - 41 * 4); // 扣除全零秒组合
});
