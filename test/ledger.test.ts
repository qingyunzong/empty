import { test } from "node:test";
import assert from "node:assert/strict";
import { RateInterval } from "../src/billing.js";
import { computeBill, correctBill, publishBill } from "../src/engine.js";
import { Ledger, LedgerEntry } from "../src/ledger.js";

const rates: RateInterval[] = [
  { start: 0, end: 3600, rateCentsPerMin: 2 },
  { start: 3600, end: 7200, rateCentsPerMin: 5 },
];

const users = [
  { userId: "alice", online: [{ start: 10, end: 130 }, { start: 100, end: 3700 }] },
  { userId: "bob", online: [{ start: 60, end: 180 }, { start: 3660, end: 3720 }] },
];

test("逐段与整单金额守恒", () => {
  const bill = computeBill("B1", users, rates);
  // 每段：Σ 分账 = 段费用
  for (const line of bill.lines) {
    const allocated = line.shares.reduce((s, x) => s + x.amountCents, 0);
    assert.equal(allocated, line.segment.feeCents, line.segmentId);
  }
  // 整单：Σ 段费用 = 总费用 = Σ 分录
  const segmentSum = bill.lines.reduce((s, l) => s + l.segment.feeCents, 0);
  assert.equal(segmentSum, bill.totalCents);
  const entrySum = bill.entries.reduce((s, e) => s + e.amountCents, 0);
  assert.equal(entrySum, bill.totalCents);
});

test("账本幂等入账：重复 post 同键分录不重复", () => {
  const ledger = new Ledger();
  const bill = computeBill("B1", users, rates);
  publishBill(ledger, bill);
  const sizeAfterFirst = ledger.size();
  publishBill(ledger, bill); // 重放
  assert.equal(ledger.size(), sizeAfterFirst);
  assert.equal(ledger.totalCents(), bill.totalCents);
});

test("幂等键冲突（同键不同额）抛错", () => {
  const ledger = new Ledger();
  const entry: LedgerEntry = {
    key: "k1",
    billId: "B1",
    type: "charge",
    userId: "alice",
    segmentId: "s0",
    amountCents: 10,
    memo: "",
  };
  ledger.post(entry);
  assert.throws(() => ledger.post({ ...entry, amountCents: 11 }));
});

test("历史更正：发冲正账，已发布账不变", () => {
  const ledger = new Ledger();
  const original = computeBill("B1", users, rates);
  publishBill(ledger, original);
  const publishedBefore = ledger.posted();

  const correctedUsers = [
    { userId: "alice", online: [{ start: 10, end: 130 }, { start: 100, end: 300 }] },
    { userId: "bob", online: [{ start: 60, end: 180 }, { start: 3660, end: 3720 }] },
  ];
  const corrected = correctBill(ledger, original, "B1-C1", correctedUsers, rates);

  // 原分录逐字保留（已发布账不被修改）
  const after = ledger.posted();
  for (const e of publishedBefore) {
    assert.ok(
      after.some(
        (x) =>
          x.key === e.key &&
          x.amountCents === e.amountCents &&
          x.type === e.type &&
          x.userId === e.userId,
      ),
      `原分录被改动: ${e.key}`,
    );
  }

  // 冲正账：每笔原分录都有一笔等额反向冲正
  const reversals = after.filter((e) => e.type === "reversal");
  assert.equal(reversals.length, original.entries.length);
  for (const entry of original.entries) {
    const rev = reversals.find((r) => r.key === `B1-C1:rev:${entry.key}`);
    assert.ok(rev, `缺少冲正: ${entry.key}`);
    assert.equal(rev!.amountCents, -entry.amountCents);
    assert.equal(rev!.userId, entry.userId);
  }

  // 净效果 = 更正后账单
  assert.equal(ledger.totalCents(), corrected.totalCents);
  for (const userId of ["alice", "bob"]) {
    const want = corrected.entries
      .filter((e) => e.userId === userId)
      .reduce((s, e) => s + e.amountCents, 0);
    assert.equal(ledger.balanceCents(userId), want, userId);
  }
});

test("对未发布的账单冲正抛错", () => {
  const ledger = new Ledger();
  const bill = computeBill("B1", users, rates);
  assert.throws(() => correctBill(ledger, bill, "B1-C1", users, rates));
});
