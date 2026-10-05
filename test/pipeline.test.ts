import { test } from "node:test";
import assert from "node:assert/strict";
import { RateInterval } from "../src/billing.js";
import { BillingPipeline, Command } from "../src/pipeline.js";

const rates: RateInterval[] = [
  { start: 0, end: 3600, rateCentsPerMin: 2 },
  { start: 3600, end: 7200, rateCentsPerMin: 5 },
];

const usersV1 = [
  { userId: "alice", online: [{ start: 10, end: 130 }, { start: 100, end: 3700 }] },
  { userId: "bob", online: [{ start: 60, end: 180 }, { start: 3660, end: 3720 }] },
];
const usersV2 = [
  { userId: "alice", online: [{ start: 10, end: 130 }, { start: 100, end: 300 }] },
  { userId: "bob", online: [{ start: 60, end: 180 }, { start: 3660, end: 3720 }] },
];
const usersV3 = [
  { userId: "carol", online: [{ start: 4000, end: 4100 }] },
  { userId: "dave", online: [{ start: 4050, end: 4200 }] },
];

const commands: Command[] = [
  { kind: "publish", billId: "B1", users: usersV1, rates },
  { kind: "publish", billId: "B2", users: usersV3, rates },
  { kind: "correct", billId: "B1-C1", originalBillId: "B1", users: usersV2, rates },
  { kind: "publish", billId: "B3", users: usersV1, rates },
];

test("断点重放幂等：从断点重放与全量执行结果一致", () => {
  const full = new BillingPipeline();
  for (const cmd of commands) full.apply(cmd);
  const fullHash = full.ledgerHash();
  const fullSize = full.getLedger().size();

  // 在每个断点处恢复快放剩余命令，结果必须与全量一致
  for (let cut = 0; cut <= commands.length; cut++) {
    const head = new BillingPipeline();
    for (const cmd of commands.slice(0, cut)) head.apply(cmd);
    const checkpoint = head.checkpoint();
    assert.equal(checkpoint.seq, cut);

    const restored = BillingPipeline.restore(checkpoint);
    restored.replay(commands.slice(cut));
    assert.equal(restored.ledgerHash(), fullHash, `断点 ${cut} 重放后账本不一致`);
    assert.equal(restored.getLedger().size(), fullSize);

    // 重复重放同一段命令：幂等，不产生重复分录
    restored.replay(commands.slice(cut));
    assert.equal(restored.ledgerHash(), fullHash, `断点 ${cut} 重复重放后账本不一致`);
    assert.equal(restored.getLedger().size(), fullSize);
  }
});

test("同一命令重复 apply 幂等", () => {
  const pipeline = new BillingPipeline();
  pipeline.apply(commands[0]!);
  const hash = pipeline.ledgerHash();
  const size = pipeline.getLedger().size();
  pipeline.apply(commands[0]!);
  assert.equal(pipeline.ledgerHash(), hash);
  assert.equal(pipeline.getLedger().size(), size);
});

test("更正命令在重放中保持守恒", () => {
  const pipeline = new BillingPipeline();
  for (const cmd of commands) pipeline.apply(cmd);
  const ledger = pipeline.getLedger();

  // 账本净额 = 各账单（含更正账）的 charge 合计（冲正已抵消原账）
  const corrected = pipeline.getBill("B1-C1")!;
  const b2 = pipeline.getBill("B2")!;
  const b3 = pipeline.getBill("B3")!;
  assert.equal(
    ledger.totalCents(),
    corrected.totalCents + b2.totalCents + b3.totalCents,
  );

  // 逐用户核对
  for (const userId of ["alice", "bob", "carol", "dave"]) {
    const want = [corrected, b2, b3]
      .flatMap((b) => b.entries)
      .filter((e) => e.userId === userId)
      .reduce((s, e) => s + e.amountCents, 0);
    assert.equal(ledger.balanceCents(userId), want, userId);
  }
});
