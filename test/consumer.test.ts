import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConsumerHooks } from "../src/consumer.js";
import { drain, LEASE_MS, makeWorld } from "./helpers.js";

describe("consumer: ID 事务去重 + 故障注入", () => {
  it("无故障基线：每条消息效果恰好一次，无重投", () => {
    const world = makeWorld();
    world.broker.publish({ id: "m1", payload: "a" });
    world.broker.publish({ id: "m2", payload: "b" });

    drain(world);

    assert.deepEqual(world.store.effectLog(), ["effect:a", "effect:b"]);
    assert.equal(world.trace.count("delivered"), 2);
    assert.equal(world.trace.count("duplicate-suppressed"), 0);
    assert.equal(world.broker.pendingCount(), 0);
  });

  it("处理端提交故障：事务回滚不发 ACK，重投后效果仍只一次", () => {
    const world = makeWorld();
    world.broker.publish({ id: "m1", payload: "a" });
    world.store.injectCommitFailure(2); // 前两次提交都失败回滚

    assert.equal(world.consumer.pollOnce(), "commit-failed");
    assert.equal(world.store.effectCount(), 0); // 回滚：无效果、无去重标记
    assert.equal(world.store.has("m1"), false);

    world.clock.advance(LEASE_MS + 1);
    assert.equal(world.consumer.pollOnce(), "commit-failed");
    assert.equal(world.store.effectCount(), 0);

    world.clock.advance(LEASE_MS + 1);
    drain(world); // 第三次投递成功

    assert.deepEqual(world.store.effectLog(), ["effect:a"]);
    assert.equal(world.trace.count("delivered"), 3); // 轨迹保留全部 3 次投递
    assert.equal(world.trace.count("tx-rollback"), 2);
    assert.equal(world.trace.count("tx-commit"), 1);
    assert.equal(world.trace.count("ack-accepted"), 1);
    assert.equal(world.broker.pendingCount(), 0);
  });

  it("效果已提交但 ACK 时代理崩溃：旧世代 ACK 被拒，重投被去重抑制", () => {
    const hooks: ConsumerHooks = {};
    const world = makeWorld(hooks);
    hooks.beforeAck = () => world.broker.crash(); // 提交后、ACK 前代理重启
    world.broker.publish({ id: "m1", payload: "a" });

    assert.equal(world.consumer.pollOnce(), "processed"); // 效果已提交，ACK 被拒
    assert.deepEqual(world.store.effectLog(), ["effect:a"]);
    assert.equal(world.trace.count("ack-rejected"), 1);
    assert.equal(
      world.trace.ofType("ack-rejected")[0]?.detail["reason"],
      "stale-generation",
    );

    drain(world); // 重投 -> 去重抑制 -> 新世代 ACK 成功

    assert.deepEqual(world.store.effectLog(), ["effect:a"]); // 业务效果仍一次
    assert.equal(world.trace.count("delivered"), 2); // 轨迹保留重复投递
    assert.equal(world.trace.count("duplicate-suppressed"), 1);
    assert.equal(world.trace.count("ack-accepted"), 1);
    assert.equal(world.broker.pendingCount(), 0);
  });

  it("代理丢失已确认状态导致已 ACK 消息重投，去重保证效果不重复", () => {
    const hooks: ConsumerHooks = {};
    const world = makeWorld(hooks);
    let crashed = false;
    hooks.afterAck = (_delivery, result) => {
      if (result.ok && !crashed) {
        crashed = true;
        world.broker.crash({ loseAcked: true });
      }
    };
    world.broker.publish({ id: "m1", payload: "a" });

    drain(world);

    assert.deepEqual(world.store.effectLog(), ["effect:a"]);
    assert.equal(world.trace.count("delivered"), 2); // 重投被记录在轨迹
    assert.equal(world.trace.count("duplicate-suppressed"), 1);
    assert.equal(world.trace.count("ack-accepted"), 2); // 崩溃前后各确认一次
    assert.equal(world.broker.pendingCount(), 0);
  });
});
