import test from "node:test";
import assert from "node:assert/strict";
import { canonicalize, certify } from "../src/certificate";
import { runScenario } from "../src/scenario";

test("canonicalize 键序稳定", () => {
  const a = canonicalize({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } });
  const b = canonicalize({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 });
  assert.equal(a, b);
});

test("增量状态与从头重放的状态证书一致", () => {
  const { world, replayed, events } = runScenario();
  const live = certify(world);
  const replayedCert = certify(replayed);
  assert.equal(live.sha256, replayedCert.sha256);
  assert.equal(live.eventCount, events.length);
  assert.equal(live.lastSeq, events.length);
});

test("场景物料账守恒：收货 = 在库 + 在制 + 保留 + 耗用 + 损耗", () => {
  const { world } = runScenario();
  const received = world.ledger
    .filter((e) => e.reason === "stock-received")
    .reduce<Record<string, number>>((acc, e) => {
      acc[e.material] = (acc[e.material] ?? 0) + e.qty;
      return acc;
    }, {});
  for (const [material, account] of Object.entries(world.materials)) {
    const total = received[material] ?? 0;
    const sum = account.onHand + account.held + account.retained + account.consumed + account.lost;
    assert.equal(sum, total, `物料 ${material} 账不守恒`);
  }
});

test("场景关键结果：A 取消、B 完工、保留料未被重复消耗", () => {
  const { world } = runScenario();
  assert.equal(world.orders["A"]?.status, "cancelled");
  assert.equal(world.orders["B"]?.status, "completed");
  const steel = world.materials["steel"];
  assert.equal(steel?.consumed, 10 + 6 + 8);
  assert.equal(steel?.lost, 5);
  assert.equal(steel?.reversed, 0);
  const plastic = world.materials["plastic"];
  assert.equal(plastic?.lost, 2);
  assert.equal(plastic?.reversed, 3);
  const retryConsumes = world.ledger.filter((e) => e.reason === "retry-consume-shortfall");
  assert.deepEqual(
    retryConsumes.map((e) => [e.material, e.qty]),
    [["steel", 5]],
  );
});
