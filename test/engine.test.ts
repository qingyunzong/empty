import test from "node:test";
import assert from "node:assert/strict";
import { append, DomainError, replay } from "../src/engine";
import type { SequencedEvent } from "../src/events";
import { initialWorld, type World } from "../src/model";

function bootstrap(): World {
  const world = initialWorld();
  append(world, { kind: "StockReceived", material: "steel", qty: 50 });
  append(world, { kind: "EquipmentRegistered", equipment: "press-1" });
  append(world, {
    kind: "OrderPlaced",
    order: "A",
    stages: [
      { name: "cut", materials: { steel: 10 }, equipment: "press-1", recovery: { steel: 0.5 } },
      { name: "form", materials: { steel: 4 }, equipment: "press-1", recovery: { steel: 1 } },
    ],
  });
  return world;
}

test("开工占用原料与设备", () => {
  const world = bootstrap();
  append(world, { kind: "StageStarted", order: "A", stage: "cut" });
  assert.equal(world.materials["steel"]?.onHand, 40);
  assert.equal(world.materials["steel"]?.held, 10);
  assert.deepEqual(world.equipment["press-1"]?.busyBy, { order: "A", stage: "cut" });
});

test("失败按阶段回收率决定可回收原料", () => {
  const world = bootstrap();
  append(world, { kind: "StageStarted", order: "A", stage: "cut" });
  append(world, { kind: "StageFailed", order: "A", stage: "cut" });
  const steel = world.materials["steel"];
  assert.equal(steel?.retained, 5);
  assert.equal(steel?.lost, 5);
  assert.equal(steel?.held, 0);
  assert.equal(world.equipment["press-1"]?.busyBy, null);
});

test("重试只补差量，不重复消耗已保留料", () => {
  const world = bootstrap();
  append(world, { kind: "StageStarted", order: "A", stage: "cut" });
  append(world, { kind: "StageFailed", order: "A", stage: "cut" });
  const onHandBefore = world.materials["steel"]?.onHand ?? 0;
  append(world, { kind: "StageRetried", order: "A", stage: "cut" });
  const steel = world.materials["steel"];
  assert.equal(steel?.onHand, onHandBefore - 5);
  assert.equal(steel?.retained, 0);
  assert.equal(steel?.held, 10);
  const retryEntries = world.ledger.filter((e) => e.reason.startsWith("retry-"));
  assert.deepEqual(
    retryEntries.map((e) => [e.from, e.to, e.qty]),
    [
      ["retained", "held", 5],
      ["onHand", "held", 5],
    ],
  );
});

test("未失败不能重试，未开工不能完工", () => {
  const world = bootstrap();
  assert.throws(
    () => append(world, { kind: "StageRetried", order: "A", stage: "cut" }),
    (err) => err instanceof DomainError && /不能重试/.test(err.message),
  );
  assert.throws(
    () => append(world, { kind: "StageCompleted", order: "A", stage: "cut" }),
    (err) => err instanceof DomainError && /不能完工/.test(err.message),
  );
});

test("整单取消产生逆向补料并释放占用", () => {
  const world = bootstrap();
  append(world, { kind: "StageStarted", order: "A", stage: "cut" });
  append(world, { kind: "StageFailed", order: "A", stage: "cut" });
  append(world, { kind: "StageRetried", order: "A", stage: "cut" });
  append(world, { kind: "StageCompleted", order: "A", stage: "cut" });
  append(world, { kind: "StageStarted", order: "A", stage: "form" });
  append(world, { kind: "StageFailed", order: "A", stage: "form" });
  append(world, { kind: "OrderCancelled", order: "A" });
  const steel = world.materials["steel"];
  assert.equal(steel?.consumed, 10);
  assert.equal(steel?.reversed, 4);
  assert.equal(steel?.onHand, 50 - 10 - 5);
  assert.equal(world.orders["A"]?.status, "cancelled");
  assert.equal(world.equipment["press-1"]?.busyBy, null);
  const reverse = world.ledger.filter((e) => e.reason === "reverse-replenishment");
  assert.deepEqual(
    reverse.map((e) => [e.material, e.from, e.to, e.qty]),
    [["steel", "retained", "onHand", 4]],
  );
});

test("库存不足与设备占用被拒绝", () => {
  const world = initialWorld();
  append(world, { kind: "StockReceived", material: "steel", qty: 3 });
  append(world, { kind: "EquipmentRegistered", equipment: "press-1" });
  append(world, {
    kind: "OrderPlaced",
    order: "A",
    stages: [{ name: "cut", materials: { steel: 10 }, equipment: "press-1", recovery: {} }],
  });
  assert.throws(() => append(world, { kind: "StageStarted", order: "A", stage: "cut" }), DomainError);

  const busy = bootstrap();
  append(busy, {
    kind: "OrderPlaced",
    order: "B",
    stages: [{ name: "cut", materials: { steel: 1 }, equipment: "press-1", recovery: {} }],
  });
  append(busy, { kind: "StageStarted", order: "A", stage: "cut" });
  assert.throws(
    () => append(busy, { kind: "StageStarted", order: "B", stage: "cut" }),
    (err) => err instanceof DomainError && /占用/.test(err.message),
  );
});

test("前置阶段未完工不能开工", () => {
  const world = bootstrap();
  assert.throws(
    () => append(world, { kind: "StageStarted", order: "A", stage: "form" }),
    (err) => err instanceof DomainError && /前置阶段/.test(err.message),
  );
});

test("失败事件序号连续且显式", () => {
  const world = bootstrap();
  const first = append(world, { kind: "StageStarted", order: "A", stage: "cut" });
  const second = append(world, { kind: "StageCompleted", order: "A", stage: "cut" });
  assert.equal(second.seq, first.seq + 1);
  assert.equal(world.seq, 5);
});

test("重放校验事件顺序断裂", () => {
  const events: SequencedEvent[] = [
    { kind: "StockReceived", material: "steel", qty: 5, seq: 1 },
    { kind: "StockReceived", material: "steel", qty: 5, seq: 3 },
  ];
  assert.throws(
    () => replay(events),
    (err) => err instanceof DomainError && /顺序断裂/.test(err.message),
  );
});
