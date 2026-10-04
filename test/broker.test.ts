import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Broker } from "../src/broker.js";
import { ManualClock } from "../src/clock.js";
import { TraceLog } from "../src/trace.js";
import { LEASE_MS, SUB } from "./helpers.js";

function setup() {
  const clock = new ManualClock();
  const trace = new TraceLog(clock.now);
  const broker = new Broker(trace, clock.now, LEASE_MS);
  return { clock, trace, broker };
}

describe("broker: 租约 / ACK / 重投 / 世代", () => {
  it("正常流程：领取后 ACK，不再重投", () => {
    const { trace, broker } = setup();
    broker.subscribe(SUB);
    broker.publish({ id: "m1", payload: "a" });

    const d = broker.pull(SUB);
    assert.ok(d);
    assert.equal(d.attempt, 1);
    assert.equal(d.generation, 1);

    assert.deepEqual(broker.ack(d), { ok: true });
    assert.equal(broker.pendingCount(), 0);
    assert.equal(broker.pull(SUB), null);
    assert.equal(trace.count("redelivered"), 0);
  });

  it("租约过期未 ACK 自动重投，attempt 递增", () => {
    const { clock, trace, broker } = setup();
    broker.subscribe(SUB);
    broker.publish({ id: "m1", payload: "a" });

    const first = broker.pull(SUB);
    assert.ok(first);
    clock.advance(LEASE_MS + 1); // 越过租约

    const second = broker.pull(SUB);
    assert.ok(second);
    assert.equal(second.message.id, "m1");
    assert.equal(second.attempt, 2);
    assert.notEqual(second.deliveryId, first.deliveryId);
    assert.equal(trace.count("lease-expired"), 1);
    assert.equal(trace.count("redelivered"), 1);

    // 旧租约凭证已失效，ACK 被拒绝
    assert.deepEqual(broker.ack(first), { ok: false, reason: "unknown-lease" });
    assert.deepEqual(broker.ack(second), { ok: true });
  });

  it("订阅世代更换后旧 ACK 无效，消息在新世代重投", () => {
    const { trace, broker } = setup();
    broker.subscribe(SUB);
    broker.publish({ id: "m1", payload: "a" });

    const stale = broker.pull(SUB);
    assert.ok(stale);
    assert.equal(stale.generation, 1);

    broker.crash(); // 代理重启：在飞租约丢失，世代 1 -> 2
    assert.equal(broker.generationOf(SUB), 2);

    const staleAck = broker.ack(stale);
    assert.deepEqual(staleAck, { ok: false, reason: "stale-generation" });

    const fresh = broker.pull(SUB);
    assert.ok(fresh);
    assert.equal(fresh.generation, 2);
    assert.equal(fresh.attempt, 2);
    assert.deepEqual(broker.ack(fresh), { ok: true });
    assert.equal(broker.pendingCount(), 0);

    const rejected = trace.ofType("ack-rejected");
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]?.detail["reason"], "stale-generation");
  });

  it("重新订阅也会推进世代，旧 ACK 随之失效", () => {
    const { broker } = setup();
    broker.subscribe(SUB);
    broker.publish({ id: "m1", payload: "a" });
    const d = broker.pull(SUB);
    assert.ok(d);

    broker.subscribe(SUB); // 订阅世代 1 -> 2
    assert.deepEqual(broker.ack(d), { ok: false, reason: "stale-generation" });
  });

  it("崩溃丢失已确认状态时，已 ACK 消息按至少一次语义重投", () => {
    const { trace, broker } = setup();
    broker.subscribe(SUB);
    broker.publish({ id: "m1", payload: "a" });
    const d = broker.pull(SUB);
    assert.ok(d);
    assert.deepEqual(broker.ack(d), { ok: true });
    assert.equal(broker.pendingCount(), 0);

    broker.crash({ loseAcked: true });
    assert.equal(broker.pendingCount(), 1);

    const again = broker.pull(SUB);
    assert.ok(again);
    assert.equal(again.message.id, "m1");
    assert.equal(again.attempt, 2);
    assert.equal(trace.count("redelivered"), 1);
  });

  it("代理不可用期间 pull / ACK 直接失败", () => {
    const { broker } = setup();
    broker.subscribe(SUB);
    broker.publish({ id: "m1", payload: "a" });
    const d = broker.pull(SUB);
    assert.ok(d);

    broker.setDown(true);
    assert.equal(broker.pull(SUB), null);
    assert.deepEqual(broker.ack(d), { ok: false, reason: "broker-unavailable" });

    broker.setDown(false);
    assert.deepEqual(broker.ack(d), { ok: true });
  });
});
