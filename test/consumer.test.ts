import { test } from "node:test";
import assert from "node:assert/strict";
import { Broker } from "../src/broker";
import { LedgerStore } from "../src/store";
import { Consumer, TraceEntry } from "../src/consumer";
import { failTimes } from "../src/faults";

function traceOf(trace: TraceEntry[], id: string): TraceEntry[] {
  return trace.filter((e) => e.messageId === id);
}

test("broker ACK failure: business effect applied once, trace keeps the duplicate", () => {
  const broker = new Broker({ leaseMs: 100 });
  const store = new LedgerStore();
  const sub = broker.subscribe("transfers");
  const consumer = new Consumer(broker, store, sub);

  const id = broker.publish("transfers", { account: "alice", amount: 50 });
  broker.beforeAck = failTimes(1, "broker ack lost"); // first ACK is dropped

  consumer.poll(); // delivers + applies, ACK fails at the broker
  broker.advance(100); // lease expires -> redelivery
  consumer.poll(); // duplicate delivery, deduped by id, ACK succeeds

  assert.equal(store.balanceOf("alice"), 50, "effect applied exactly once");
  assert.equal(store.appliedCount(), 1);

  const entries = traceOf(consumer.trace, id);
  assert.equal(entries.length, 2, "trace retains the duplicate delivery");
  assert.deepEqual(
    entries.map((e) => [e.attempt, e.effect, e.ack]),
    [
      [1, "applied", "broker-failed"],
      [2, "duplicate", "acked"],
    ],
  );
});

test("consumer commit failure: transaction rolls back, retry applies once", () => {
  const broker = new Broker({ leaseMs: 100 });
  const store = new LedgerStore();
  const sub = broker.subscribe("transfers");
  const consumer = new Consumer(broker, store, sub);

  const id = broker.publish("transfers", { account: "bob", amount: 70 });
  store.beforeCommit = failTimes(1, "db commit failed"); // first commit rolls back

  consumer.poll(); // commit fails -> rollback -> no ACK
  assert.equal(store.balanceOf("bob"), 0, "rollback leaves no partial effect");

  broker.advance(100); // lease expires -> redelivery
  consumer.poll(); // retry commits

  assert.equal(store.balanceOf("bob"), 70, "effect applied exactly once");
  assert.equal(store.appliedCount(), 1);

  const entries = traceOf(consumer.trace, id);
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((e) => [e.attempt, e.effect, e.ack]),
    [
      [1, "rolled-back", "not-attempted"],
      [2, "applied", "acked"],
    ],
  );
});

test("generation change mid-processing: stale ACK rejected, redelivery deduped", () => {
  const broker = new Broker({ leaseMs: 1000 });
  const store = new LedgerStore();
  const sub = broker.subscribe("transfers");

  const id = broker.publish("transfers", { account: "carol", amount: 30 });

  // Consumer fetches under generation 1...
  const gen1 = broker.fetch(sub, 10);
  assert.equal(gen1.deliveries.length, 1);
  // ...applies the effect...
  assert.equal(store.applyTransfer(id, "carol", 30), true);
  // ...but the subscription rebalances before the ACK arrives.
  broker.resubscribe(sub);
  const stale = broker.ack(sub, gen1.generation, [id]);
  assert.deepEqual(stale.rejected, [id], "old-generation ACK is invalid");

  // Redelivered under generation 2; consumer dedups and ACKs with the new generation.
  const consumer = new Consumer(broker, store, sub);
  consumer.poll();

  assert.equal(store.balanceOf("carol"), 30, "effect applied exactly once");
  assert.equal(store.appliedCount(), 1);

  const entries = traceOf(consumer.trace, id);
  assert.equal(entries.length, 1);
  assert.deepEqual(
    entries.map((e) => [e.generation, e.attempt, e.effect, e.ack]),
    [[2, 2, "duplicate", "acked"]],
  );
});

test("mixed faults across a batch: every transfer lands exactly once", () => {
  const broker = new Broker({ leaseMs: 100 });
  const store = new LedgerStore();
  const sub = broker.subscribe("transfers");
  const consumer = new Consumer(broker, store, sub, 2);

  const ids = [
    broker.publish("transfers", { account: "a", amount: 10 }),
    broker.publish("transfers", { account: "a", amount: 20 }),
    broker.publish("transfers", { account: "b", amount: 5 }),
  ];
  broker.beforeAck = failTimes(2, "flaky broker"); // first two ACKs lost
  store.beforeCommit = failTimes(1, "flaky db"); // first commit rolls back

  // Drain with retries until everything is ACKed.
  for (let round = 0; round < 10; round++) {
    consumer.poll();
    broker.advance(100);
  }

  assert.equal(store.balanceOf("a"), 30);
  assert.equal(store.balanceOf("b"), 5);
  assert.equal(store.appliedCount(), 3, "each id applied exactly once");

  const duplicates = consumer.trace.filter((e) => e.effect === "duplicate");
  const rollbacks = consumer.trace.filter((e) => e.effect === "rolled-back");
  assert.ok(duplicates.length >= 2, "trace retains duplicate deliveries");
  assert.ok(rollbacks.length >= 1, "trace retains the rolled-back attempt");
  for (const id of ids) {
    const applied = traceOf(consumer.trace, id).filter((e) => e.effect === "applied");
    assert.equal(applied.length, 1, `message ${id} applied exactly once in the trace`);
  }
});
