import { test } from "node:test";
import assert from "node:assert/strict";
import { Broker } from "../src/broker";

test("lease fetch then ACK: message is delivered exactly once", () => {
  const broker = new Broker({ leaseMs: 100 });
  const sub = broker.subscribe("t");
  const id = broker.publish("t", { n: 1 });

  const first = broker.fetch(sub, 10);
  assert.equal(first.deliveries.length, 1);
  assert.equal(first.deliveries[0].id, id);
  assert.equal(first.deliveries[0].attempt, 1);

  const res = broker.ack(sub, first.generation, [id]);
  assert.deepEqual(res.acked, [id]);

  broker.advance(1000);
  const second = broker.fetch(sub, 10);
  assert.equal(second.deliveries.length, 0);
});

test("unacknowledged lease expires and the message is redelivered (at-least-once)", () => {
  const broker = new Broker({ leaseMs: 100 });
  const sub = broker.subscribe("t");
  const id = broker.publish("t", { n: 1 });

  const first = broker.fetch(sub, 10);
  assert.equal(first.deliveries.length, 1);

  // Lease still valid: no redelivery yet.
  broker.advance(50);
  assert.equal(broker.fetch(sub, 10).deliveries.length, 0);

  // Lease expired: redelivery with a bumped attempt counter.
  broker.advance(50);
  const again = broker.fetch(sub, 10);
  assert.equal(again.deliveries.length, 1);
  assert.equal(again.deliveries[0].id, id);
  assert.equal(again.deliveries[0].attempt, 2);
});

test("generation change invalidates old ACKs; new-generation ACK works", () => {
  const broker = new Broker({ leaseMs: 100 });
  const sub = broker.subscribe("t");
  const id = broker.publish("t", { n: 1 });

  const gen1 = broker.fetch(sub, 10);
  assert.equal(gen1.generation, 1);

  const gen2 = broker.resubscribe(sub);
  assert.equal(gen2, 2);

  // ACK quoting the old generation is rejected; the message survives.
  const stale = broker.ack(sub, gen1.generation, [id]);
  assert.deepEqual(stale.acked, []);
  assert.deepEqual(stale.rejected, [id]);

  // Recalled lease is redelivered under the new generation.
  const redelivered = broker.fetch(sub, 10);
  assert.equal(redelivered.generation, 2);
  assert.equal(redelivered.deliveries.length, 1);
  assert.equal(redelivered.deliveries[0].id, id);

  const fresh = broker.ack(sub, redelivered.generation, [id]);
  assert.deepEqual(fresh.acked, [id]);
  assert.equal(broker.fetch(sub, 10).deliveries.length, 0);
});

test("broker-side ACK failure keeps the lease for redelivery", () => {
  const broker = new Broker({ leaseMs: 100 });
  const sub = broker.subscribe("t");
  const id = broker.publish("t", { n: 1 });

  const fetched = broker.fetch(sub, 10);
  broker.beforeAck = () => {
    throw new Error("broker unavailable");
  };
  assert.throws(() => broker.ack(sub, fetched.generation, [id]));
  broker.beforeAck = null;

  broker.advance(100);
  const again = broker.fetch(sub, 10);
  assert.equal(again.deliveries.length, 1);
  assert.equal(again.deliveries[0].attempt, 2);
  assert.deepEqual(broker.ack(sub, again.generation, [id]).acked, [id]);
});
