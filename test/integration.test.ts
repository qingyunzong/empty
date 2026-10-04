import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConsumerHooks } from "../src/consumer.js";
import { drain, makeWorld } from "./helpers.js";

describe("端到端：代理故障 + 处理端提交故障混合注入", () => {
  it("三条消息三类故障：业务效果各一次，轨迹保留全部重复", () => {
    const hooks: ConsumerHooks = {};
    const world = makeWorld(hooks);
    const { broker, store, trace } = world;

    broker.publish({ id: "m1", payload: "a" });
    broker.publish({ id: "m2", payload: "b" });
    broker.publish({ id: "m3", payload: "c" });

    // 故障 1（处理端）：m1 首次事务提交失败回滚
    store.injectCommitFailure(1);

    // 故障 2（代理）：m2 效果提交后、ACK 前代理崩溃，世代失效
    // 故障 3（代理）：m3 ACK 后代理崩溃并丢失全部已确认状态
    let crashedBeforeAck = false;
    let crashedAfterAck = false;
    hooks.beforeAck = (delivery) => {
      if (delivery.message.id === "m2" && !crashedBeforeAck) {
        crashedBeforeAck = true;
        broker.crash();
      }
    };
    hooks.afterAck = (delivery, result) => {
      if (delivery.message.id === "m3" && result.ok && !crashedAfterAck) {
        crashedAfterAck = true;
        broker.crash({ loseAcked: true });
      }
    };

    drain(world);

    // 业务效果：每条消息恰好一次，顺序不变
    assert.deepEqual(store.effectLog(), ["effect:a", "effect:b", "effect:c"]);

    // 轨迹保留重复投递：
    // m1 = 提交失败 1 次 + 成功 1 次 + 崩溃 3 丢失确认后重投 1 次
    // m2 = 崩溃 1 前 1 次 + 重投 1 次 + 崩溃 3 丢失确认后重投 1 次
    // m3 = 成功 1 次 + 崩溃 3 丢失确认后重投 1 次
    const deliveredOf = (id: string) =>
      trace.forMessage(id).filter((e) => e.type === "delivered").length;
    assert.equal(deliveredOf("m1"), 3);
    assert.equal(deliveredOf("m2"), 3);
    assert.equal(deliveredOf("m3"), 2);
    assert.equal(trace.count("delivered"), 8);

    // 故障留下的痕迹都在轨迹里
    assert.equal(trace.count("tx-rollback"), 1); // m1 提交回滚
    assert.equal(trace.count("commit-failed-no-ack"), 1);
    assert.equal(trace.count("broker-crash"), 2);
    assert.equal(trace.count("lease-expired"), 1); // m1 租约过期触发重投
    assert.ok(
      trace.ofType("ack-rejected").some((e) => e.detail["reason"] === "stale-generation"),
      "应存在旧世代 ACK 被拒记录",
    );
    // 去重抑制：m2 重投 1 次 + 崩溃 3 后 m1/m2/m3 各 1 次
    assert.equal(trace.count("duplicate-suppressed"), 4);
    // 业务效果对应的提交只有 3 次
    assert.equal(trace.count("tx-commit"), 3);

    // 终态：代理侧全部确认，无积压
    assert.equal(broker.pendingCount(), 0);
    assert.equal(trace.count("ack-accepted"), 6); // 三条消息各被确认 2 次
  });
}
);
