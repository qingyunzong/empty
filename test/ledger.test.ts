import { test } from "node:test";
import * as assert from "node:assert/strict";
import { BillingEngine, BillingRun } from "../src/engine.js";
import { Ledger, LedgerEntry } from "../src/ledger.js";

function makeRun(runId: string, rate = 10): BillingRun {
  return {
    runId,
    accountId: "acct-1",
    online: [{ start: 0, end: 100 }], // 并集 [0,100)
    rates: [{ start: 0, end: 1000, ratePerMinuteCents: rate }],
    users: [
      { userId: "alice", online: [{ start: 0, end: 60 }] },
      { userId: "bob", online: [{ start: 40, end: 100 }] },
    ],
  };
}

test("入账：分段计费后按占用秒比例分账，逐段与全账守恒", () => {
  const ledger = new Ledger();
  const engine = new BillingEngine(ledger);
  const result = engine.applyRun(makeRun("run-1"));

  // [0,100) 100 秒 → 2 分钟 × 10 分 = 20 分
  assert.equal(result.totalFeeCents, 20);
  // alice 60 秒、bob 60 秒 → 各 10 分
  assert.equal(ledger.netCents("acct-1"), 20);
  const entries = ledger.all();
  assert.equal(entries.length, 2);
  const byUser = new Map(entries.map((e) => [e.userId, e.amountCents]));
  assert.equal(byUser.get("alice"), 10);
  assert.equal(byUser.get("bob"), 10);
  // 全账守恒：分账合计 = 总费用
  assert.equal(
    entries.reduce((s, e) => s + e.amountCents, 0),
    result.totalFeeCents,
  );
});

test("幂等：重复追加同 ID 同内容被忽略，内容冲突报错", () => {
  const ledger = new Ledger();
  const entry: LedgerEntry = {
    id: "e1",
    runId: "r",
    accountId: "a",
    segmentId: "s",
    userId: "u",
    kind: "charge",
    amountCents: 5,
  };
  assert.equal(ledger.append(entry), true);
  assert.equal(ledger.append({ ...entry }), false);
  assert.equal(ledger.all().length, 1);
  assert.throws(() => ledger.append({ ...entry, amountCents: 6 }));
});

test("历史更正：发冲正账，已发布账不被修改", () => {
  const ledger = new Ledger();
  const engine = new BillingEngine(ledger);
  engine.applyRun(makeRun("run-1"));
  ledger.publish();
  const publishedBefore = JSON.parse(JSON.stringify(ledger.published()));

  // 更正：费率从 10 改为 12，重跑为 run-2
  engine.correctRun("run-1", makeRun("run-2", 12), "费率更正");
  ledger.publish();

  // 已发布原账保持原样
  assert.deepEqual(
    ledger.published().slice(0, publishedBefore.length),
    publishedBefore,
  );
  // 冲正账存在且金额为负、引用原条目
  const reversals = ledger.all().filter((e) => e.kind === "reversal");
  assert.equal(reversals.length, 2);
  for (const rev of reversals) {
    const orig = ledger.get(rev.reverses!)!;
    assert.equal(rev.amountCents, -orig.amountCents);
    assert.equal(orig.kind, "charge");
  }
  // 净额 = 更正后费用：[0,100) 2 分钟 × 12 = 24 分
  assert.equal(ledger.netCents("acct-1"), 24);
  // 不能冲正未发布账或冲正账
  assert.throws(() => ledger.reverse("no-such-id", "x"));
  assert.throws(() => ledger.reverse(reversals[0]!.id, "y"));
});

test("断点重放幂等：崩溃后重放与一次性跑完结果一致", () => {
  const runs = [makeRun("run-1"), makeRun("run-2", 12), makeRun("run-3", 8)];

  // 参照：一次性跑完
  const full = new Ledger();
  new BillingEngine(full).replay(runs);
  full.publish();

  // 模拟断点：跑完 run-1 后“崩溃”，从序列化快照恢复，再重放全部 runs
  const crashed = new Ledger();
  const engine1 = new BillingEngine(crashed);
  engine1.applyRun(runs[0]!);
  crashed.publish();
  const snapshot = JSON.parse(JSON.stringify(crashed.toJSON()));

  const restored = Ledger.fromJSON(snapshot);
  const engine2 = new BillingEngine(restored);
  const results = engine2.replay(runs); // run-1 重放应幂等
  assert.equal(results[0]!.appendedEntries, 0);
  assert.equal(results[1]!.appendedEntries > 0, true);
  restored.publish();

  assert.deepEqual(restored.toJSON(), full.toJSON());
  assert.equal(restored.netCents("acct-1"), full.netCents("acct-1"));
});

test("重放更正流程同样幂等", () => {
  const ledger = new Ledger();
  const engine = new BillingEngine(ledger);
  engine.applyRun(makeRun("run-1"));
  ledger.publish();
  engine.correctRun("run-1", makeRun("run-2", 12));
  ledger.publish();
  const once = JSON.parse(JSON.stringify(ledger.toJSON()));

  // 重复执行同一更正：冲正 ID 与新账 ID 均确定性，全部幂等命中
  engine.correctRun("run-1", makeRun("run-2", 12));
  assert.deepEqual(JSON.parse(JSON.stringify(ledger.toJSON())), once);
});
