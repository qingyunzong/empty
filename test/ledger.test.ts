import { test } from "node:test";
import assert from "node:assert/strict";
import { SplitLedger } from "../src/ledger.js";
import { split, SplitError, type Recipient } from "../src/split.js";
import { sum } from "./helpers.js";

const recipients: Recipient[] = [
  { id: "a", weight: { num: 1, den: 2 }, min: 0, max: 1000 },
  { id: "b", weight: { num: 1, den: 3 }, min: 0, max: 1000 },
  { id: "c", weight: { num: 1, den: 6 }, min: 0, max: 1000 },
];

function expectConsistent(ledger: SplitLedger, rs: readonly Recipient[] = recipients): void {
  const allocs = ledger.allocations();
  assert.equal(
    sum(Object.values(allocs)),
    ledger.activeTotal(),
    "账本分配总额必须等于未退款订单总额",
  );
  for (const r of rs) {
    if (ledger.isLocked(r.id)) continue;
    assert.ok(allocs[r.id]! >= r.min && allocs[r.id]! <= r.max, `${r.id} 越界`);
  }
}

test("分账跨多个订单：累计后按全局权重一次性最优分配", () => {
  const ledger = new SplitLedger(recipients);
  ledger.addOrder("o1", 60);
  ledger.addOrder("o2", 40);
  expectConsistent(ledger);
  // 与直接对总额 100 做单次拆分一致（权重 1/2:1/3:1/6 = 3:2:1）。
  const direct = split(100, recipients);
  assert.deepEqual(ledger.allocations(), Object.fromEntries(direct));
  assert.deepEqual(ledger.allocations(), { a: 50, b: 33, c: 17 });
});

test("退款：撤销原订单后重新分配其余未退款订单", () => {
  const ledger = new SplitLedger(recipients);
  ledger.addOrder("o1", 60);
  ledger.addOrder("o2", 30);
  ledger.addOrder("o3", 10);
  ledger.refund("o2");
  expectConsistent(ledger);
  const direct = split(70, recipients);
  assert.deepEqual(ledger.allocations(), Object.fromEntries(direct));
  ledger.refund("o1");
  ledger.refund("o3");
  assert.deepEqual(ledger.allocations(), { a: 0, b: 0, c: 0 });
});

test("锁定金额不动：加单与退款都不改变锁定份额", () => {
  const ledger = new SplitLedger(recipients);
  ledger.addOrder("o1", 90);
  const before = ledger.allocations();
  ledger.lock("a");
  ledger.addOrder("o2", 30);
  expectConsistent(ledger);
  assert.equal(ledger.allocationOf("a"), before["a"]!, "锁定份额加单后不变");
  // 其余 120 - a 在 b、c 间按 2:1 分配。
  const rest = 120 - before["a"]!;
  assert.deepEqual(
    { b: ledger.allocationOf("b"), c: ledger.allocationOf("c") },
    Object.fromEntries(
      split(rest, [recipients[1]!, recipients[2]!]),
    ),
  );
  ledger.refund("o2");
  expectConsistent(ledger);
  assert.equal(ledger.allocationOf("a"), before["a"]!, "锁定份额退款后不变");
  // 剩余订单总额回到 90，b、c 恢复原有分配。
  assert.deepEqual(ledger.allocations(), before);
});

test("全局上下限跨订单生效", () => {
  const bounded: Recipient[] = [
    { id: "a", weight: { num: 1, den: 1 }, min: 0, max: 50 },
    { id: "b", weight: { num: 1, den: 1 }, min: 10, max: 1000 },
  ];
  const ledger = new SplitLedger(bounded);
  ledger.addOrder("o1", 40);
  ledger.addOrder("o2", 40);
  // 总额 80：a 上限 50，b 下限 10。
  assert.deepEqual(ledger.allocations(), { a: 40, b: 40 });
  ledger.addOrder("o3", 40);
  // 总额 120：a 饱和于 50，b 拿 70。
  assert.deepEqual(ledger.allocations(), { a: 50, b: 70 });
  expectConsistent(ledger, bounded);
});

test("解锁后重新参与全局分配", () => {
  const ledger = new SplitLedger(recipients);
  ledger.addOrder("o1", 90);
  ledger.lock("a");
  const lockedA = ledger.allocationOf("a");
  ledger.addOrder("o2", 30);
  ledger.unlock("a");
  expectConsistent(ledger);
  assert.notEqual(ledger.allocationOf("a"), lockedA);
  assert.deepEqual(
    ledger.allocations(),
    Object.fromEntries(split(120, recipients)),
  );
});

test("错误处理：重复订单、未知退款、重复退款、未知接收人", () => {
  const ledger = new SplitLedger(recipients);
  ledger.addOrder("o1", 10);
  assert.throws(() => ledger.addOrder("o1", 5), SplitError);
  assert.throws(() => ledger.refund("nope"), SplitError);
  ledger.refund("o1");
  assert.throws(() => ledger.refund("o1"), SplitError);
  assert.throws(() => ledger.lock("ghost"), SplitError);
  assert.throws(() => ledger.allocationOf("ghost"), SplitError);
  assert.throws(() => ledger.addOrder("o2", -1), SplitError);
});

test("锁定额超过退款后剩余总额：报错并回滚", () => {
  const ledger = new SplitLedger(recipients);
  ledger.addOrder("o1", 90);
  ledger.lock("a"); // 锁定 45
  ledger.addOrder("o2", 10);
  // 退款 o1 后仅剩 10，锁定 45 > 10，不可行。
  assert.throws(
    () => ledger.refund("o1"),
    (err: unknown) => err instanceof SplitError && err.code === "INFEASIBLE",
  );
  // 回滚：o1 仍在，分配不变。
  assert.ok(!ledger.isRefunded("o1"));
  assert.equal(ledger.activeTotal(), 100);
  expectConsistent(ledger);
});

test("不可行的加单回滚：账本保持原状", () => {
  const tight: Recipient[] = [
    { id: "a", weight: { num: 1, den: 1 }, min: 0, max: 10 },
    { id: "b", weight: { num: 1, den: 1 }, min: 0, max: 10 },
  ];
  const ledger = new SplitLedger(tight);
  ledger.addOrder("o1", 15);
  const before = ledger.allocations();
  assert.throws(() => ledger.addOrder("o2", 100), SplitError);
  assert.equal(ledger.activeTotal(), 15);
  assert.deepEqual(ledger.allocations(), before);
});
