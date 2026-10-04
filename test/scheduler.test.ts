import { test } from "node:test";
import assert from "node:assert";
import { planDeliveries, DeliveryEvent } from "../src/scheduler";

const ev = (
  id: string,
  priority: number,
  deps: string[] = [],
  metadata: Record<string, unknown> = {},
): DeliveryEvent => ({ id, priority, deps, metadata });

test("候选必须依赖全满足: 高优先级不能越过因果", () => {
  // B 优先级最高, 但依赖 A; A 必须先交付。
  const plan = planDeliveries([
    ev("A", 1),
    ev("B", 99, ["A"]),
    ev("C", 50),
  ]);
  assert.deepStrictEqual(
    plan.deliveries.map((d) => d.eventId),
    ["C", "A", "B"],
  );
});

test("候选间排序: 优先级高者优先, 并列则 ID 小者优先", () => {
  const plan = planDeliveries([
    ev("c", 5),
    ev("a", 5),
    ev("b", 9),
    ev("d", 1),
  ]);
  assert.deepStrictEqual(
    plan.deliveries.map((x) => x.eventId),
    ["b", "a", "c", "d"],
  );
});

test("取消事件: 传递后继被阻塞, 元数据保留", () => {
  const plan = planDeliveries(
    [
      ev("A", 1, [], { title: "root" }),
      ev("B", 2, ["A"], { title: "mid" }),
      ev("C", 3, ["B"], { title: "leaf" }),
      ev("D", 4, [], { title: "free" }),
    ],
    ["A"],
  );
  assert.deepStrictEqual(
    plan.deliveries.map((d) => d.eventId),
    ["D"],
  );
  assert.deepStrictEqual(plan.cancelled, [
    { eventId: "A", metadata: { title: "root" } },
  ]);
  assert.deepStrictEqual(
    plan.blocked.map((b) => b.eventId),
    ["B", "C"],
  );
  // 阻塞链: A->B 与 A->B->C。
  const bChains = plan.blocked.find((b) => b.eventId === "B")!;
  assert.deepStrictEqual(bChains.reason, "cancelled-dependency");
  assert.deepStrictEqual(bChains.chains.map((c) => c.path), [["A", "B"]]);
  assert.deepStrictEqual(bChains.metadata, { title: "mid" });
  const cChains = plan.blocked.find((b) => b.eventId === "C")!;
  assert.deepStrictEqual(cChains.chains.map((c) => c.path), [["A", "B", "C"]]);
});

test("菱形依赖的阻塞链包含全部路径", () => {
  const plan = planDeliveries(
    [
      ev("X", 1),
      ev("P", 1, ["X"]),
      ev("Q", 1, ["X"]),
      ev("R", 1, ["P", "Q"]),
    ],
    ["X"],
  );
  const r = plan.blocked.find((b) => b.eventId === "R")!;
  assert.deepStrictEqual(
    r.chains.map((c) => c.path),
    [
      ["X", "P", "R"],
      ["X", "Q", "R"],
    ],
  );
});

test("交付证书: 序号连续, 依赖交付序号正确", () => {
  const plan = planDeliveries([
    ev("A", 1),
    ev("B", 1),
    ev("C", 1, ["A", "B"]),
  ]);
  assert.deepStrictEqual(
    plan.deliveries.map((d) => d.sequence),
    [0, 1, 2],
  );
  const certC = plan.deliveries[2]!;
  assert.strictEqual(certC.eventId, "C");
  assert.deepStrictEqual(
    [...certC.satisfiedDeps].sort((x, y) => x.depId.localeCompare(y.depId)),
    [
      { depId: "A", deliveredAt: 0 },
      { depId: "B", deliveredAt: 1 },
    ],
  );
});

test("依赖环: 环上及依赖环的事件被阻塞", () => {
  const plan = planDeliveries([
    ev("A", 1, ["C"]),
    ev("B", 1, ["A"]),
    ev("C", 1, ["B"]),
    ev("D", 1, ["A"]),
    ev("E", 1),
  ]);
  assert.deepStrictEqual(
    plan.deliveries.map((d) => d.eventId),
    ["E"],
  );
  assert.deepStrictEqual(
    plan.blocked.map((b) => b.eventId),
    ["A", "B", "C", "D"],
  );
  for (const b of plan.blocked) {
    assert.strictEqual(b.reason, "dependency-cycle");
    assert.ok(b.chains.length >= 1);
    assert.strictEqual(b.chains[0]!.rootCause.kind, "cycle");
  }
});

test("输入校验: 重复 ID / 未知依赖 / 未知取消", () => {
  assert.throws(() => planDeliveries([ev("A", 1), ev("A", 2)]), /duplicate/);
  assert.throws(() => planDeliveries([ev("A", 1, ["ZZZ"])]), /unknown event/);
  assert.throws(() => planDeliveries([ev("A", 1)], ["ZZZ"]), /not found/);
});

test("确定性: 同一输入两次调度结果完全一致", () => {
  const events = [
    ev("A", 3),
    ev("B", 3, ["A"]),
    ev("C", 7),
    ev("D", 7, ["C"]),
    ev("E", 1, ["B", "D"]),
  ];
  assert.deepStrictEqual(planDeliveries(events), planDeliveries(events));
});
