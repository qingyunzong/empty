import { test } from "node:test";
import assert from "node:assert";
import { Network, NetworkConfig, Snapshot } from "../src/network.js";

// 快照重放与逐 tick 模型核对：从 JSON 快照恢复后继续运行，
// 每个 tick 的客户数、事件流与最终服务时间记录必须与不间断运行完全一致。
const cfg: NetworkConfig = {
  seed: 42,
  stations: [
    { id: "A", queueCapacity: 2, servers: 1, serviceMin: 1, serviceMax: 3 },
    { id: "B", queueCapacity: 2, servers: 2, serviceMin: 1, serviceMax: 2 },
    { id: "C", queueCapacity: 1, servers: 1, serviceMin: 2, serviceMax: 4 },
  ],
  sources: [{ route: ["A", "B", "C"], probability: 0.8 }],
};

test("snapshot replay reconciles with the tick-by-tick model", () => {
  const straight = new Network(cfg);
  straight.run(30);

  // snapshot goes through JSON to prove it is fully serializable
  const snap = JSON.parse(JSON.stringify(straight.snapshot())) as Snapshot;
  const replayed = Network.restore(cfg, snap);

  // same state at the restore point
  assert.deepEqual(replayed.counts(), straight.counts());
  assert.equal(replayed.customerCount(), straight.customerCount());
  assert.equal(replayed.tickCount, 30);

  // step both models tick by tick and reconcile after every tick
  for (let i = 0; i < 50; i++) {
    const evReplayed = replayed.step();
    const evStraight = straight.step();
    assert.deepEqual(evReplayed, evStraight, `events diverge at tick ${evStraight.tick}`);
    assert.deepEqual(replayed.counts(), straight.counts(), `counts diverge at tick ${evStraight.tick}`);
  }

  // customer counts and service-time records match at the end
  assert.equal(replayed.customerCount(), straight.customerCount());
  assert.equal(replayed.departed, straight.departed);
  assert.equal(replayed.dropped, straight.dropped);
  assert.equal(replayed.arrived, straight.arrived);
  assert.deepEqual(replayed.getServiceLog(), straight.getServiceLog());
  assert.ok(straight.getServiceLog().length > 0, "expected some service records");

  // sanity: the 80-tick run actually processed customers end to end
  assert.ok(straight.departed > 0, "expected departures");
  assert.ok(straight.dropped > 0, "expected drops from bounded queues");
});

test("an independent uninterrupted run reaches the same final state", () => {
  const reference = new Network(cfg);
  reference.run(80);

  const paused = new Network(cfg);
  paused.run(30);
  const restored = Network.restore(cfg, paused.snapshot());
  restored.run(50);

  assert.deepEqual(restored.counts(), reference.counts());
  assert.equal(restored.customerCount(), reference.customerCount());
  assert.deepEqual(restored.getServiceLog(), reference.getServiceLog());
});
