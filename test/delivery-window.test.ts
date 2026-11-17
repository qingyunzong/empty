import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BufferFullError,
  DeliveryWindow,
  SequenceNotDeliveredError,
  WindowCancelledError,
  type Delivery,
} from "../src/index.ts";

function pushAndDeliver<T>(
  window: DeliveryWindow<T>,
  values: readonly T[],
): Delivery<T>[] {
  for (const value of values) {
    window.push(value);
  }
  const deliveries: Delivery<T>[] = [];
  for (let index = 0; index < values.length; index++) {
    const delivery = window.poll();
    assert.ok(delivery, `expected delivery ${index}`);
    deliveries.push(delivery);
  }
  return deliveries;
}

test("in-flight capacity bounds first deliveries", () => {
  const window = new DeliveryWindow<string>({ capacity: 2 });
  assert.equal(window.push("a"), 0);
  assert.equal(window.push("b"), 1);
  assert.equal(window.push("c"), 2);

  assert.deepEqual(window.poll(), {
    seq: 0,
    value: "a",
    attempt: 1,
    redelivered: false,
  });
  assert.deepEqual(window.poll(), {
    seq: 1,
    value: "b",
    attempt: 1,
    redelivered: false,
  });
  assert.equal(window.poll(), undefined);
  assert.equal(window.inFlight, 2);
  assert.equal(window.buffered, 1);

  window.ackSelective(0);
  assert.equal(window.inFlight, 1);
  assert.deepEqual(window.poll(), {
    seq: 2,
    value: "c",
    attempt: 1,
    redelivered: false,
  });
});

test("selective acks only advance across a contiguous prefix", () => {
  const window = new DeliveryWindow<number>({ capacity: 5 });
  pushAndDeliver(window, [0, 1, 2, 3, 4]);

  let result = window.ackSelective([4, 2]);
  assert.deepEqual(result, {
    acknowledged: [2, 4],
    watermark: -1,
    released: 0,
  });
  assert.equal(window.stateOf(2), "acknowledged");
  assert.equal(window.stateOf(4), "acknowledged");
  assert.equal(window.watermark, -1);

  result = window.ackSelective(0);
  assert.equal(result.watermark, 0);
  assert.equal(window.stateOf(0), "released");

  result = window.ackCumulative(1);
  assert.deepEqual(result, {
    acknowledged: [1],
    watermark: 2,
    released: 2,
  });
  assert.equal(window.stateOf(1), "released");
  assert.equal(window.stateOf(2), "released");
  assert.equal(window.stateOf(3), "in-flight");

  result = window.ackSelective(3);
  assert.equal(result.watermark, 4);
  assert.equal(result.released, 2);
  for (let seq = 0; seq <= 4; seq++) {
    assert.equal(window.stateOf(seq), "released");
  }
});

test("cumulative ack fills holes and releases every covered message", () => {
  const window = new DeliveryWindow<string>({ capacity: 4 });
  pushAndDeliver(window, ["a", "b", "c", "d"]);
  window.ackSelective([2, 3]);
  assert.equal(window.watermark, -1);
  assert.equal(window.stateOf(0), "in-flight");

  const result = window.ackCumulative(3);
  assert.deepEqual(result.acknowledged, [0, 1]);
  assert.equal(result.watermark, 3);
  assert.equal(result.released, 4);
  assert.equal(window.inFlight, 0);
  assert.equal(window.stateOf(3), "released");
});

test("redelivery reuses the in-flight slot and does not consume capacity twice", () => {
  const window = new DeliveryWindow<string>({ capacity: 2 });
  pushAndDeliver(window, ["a", "b"]);
  window.push("c");
  assert.equal(window.inFlight, 2);

  assert.equal(window.nack(1), true);
  assert.equal(window.nack(1), true);
  assert.equal(window.inFlight, 2);
  assert.deepEqual(window.poll(), {
    seq: 1,
    value: "b",
    attempt: 2,
    redelivered: true,
  });
  assert.equal(window.inFlight, 2);
  assert.equal(window.poll(), undefined, "redelivery must not add a third slot");

  window.ackSelective(1);
  assert.equal(window.inFlight, 1);
  assert.equal(window.watermark, -1);
  assert.deepEqual(window.poll(), {
    seq: 2,
    value: "c",
    attempt: 1,
    redelivered: false,
  });
});

test("redelivery order is stable FIFO by first nack", () => {
  const window = new DeliveryWindow<string>({ capacity: 5 });
  pushAndDeliver(window, ["a", "b", "c", "d"]);

  assert.equal(window.nack(2), true);
  assert.equal(window.nack(0), true);
  assert.equal(window.nack(3), true);
  assert.equal(window.nack(0), true);

  const first = window.poll();
  const second = window.poll();
  const third = window.poll();
  assert.deepEqual(
    [first?.seq, second?.seq, third?.seq],
    [2, 0, 3],
  );
  assert.deepEqual(
    [first?.attempt, second?.attempt, third?.attempt],
    [2, 2, 2],
  );
  assert.equal(window.poll(), undefined);

  window.nack(2);
  const again = window.poll();
  assert.equal(again?.seq, 2);
  assert.equal(again?.attempt, 3);
});

test("acked and pending messages cannot be nacked", () => {
  const window = new DeliveryWindow<string>({
    capacity: 2,
    maxBuffered: 5,
  });
  window.push("a");
  window.push("b");
  window.push("c");
  window.poll();
  window.ackSelective(0);

  assert.equal(window.nack(0), false);
  assert.equal(window.nack(2), false);
});

test("buffer bound applies only to first-delivery backlog", () => {
  const window = new DeliveryWindow<string>({
    capacity: 1,
    maxBuffered: 2,
  });
  window.push("a");
  window.push("b");
  assert.equal(window.tryPush("c"), null);
  assert.throws(() => window.push("c"), (error: unknown) => {
    assert.ok(error instanceof BufferFullError);
    assert.equal(error.buffered, 2);
    assert.equal(error.maxBuffered, 2);
    return true;
  });

  window.poll();
  assert.equal(window.buffered, 1);
  assert.equal(window.tryPush("c"), 2);
});

test("acknowledging an undelivered sequence is rejected", () => {
  const window = new DeliveryWindow<string>({
    capacity: 3,
    maxBuffered: 5,
  });
  window.push("a");
  window.push("b");
  window.poll();

  assert.throws(() => window.ackSelective(1), SequenceNotDeliveredError);
  assert.throws(() => window.ackCumulative(1), SequenceNotDeliveredError);
  assert.equal(window.watermark, -1);
});

test("cancel rejects waiters and returns all retained messages", async () => {
  const window = new DeliveryWindow<string>({
    capacity: 2,
    maxBuffered: 3,
  });
  window.push("a");
  window.push("b");
  window.push("c");
  window.poll();
  window.poll();

  const waiting = window.next();
  const rejection = assert.rejects(
    waiting,
    (error: unknown) =>
      error instanceof WindowCancelledError && error.reason === "shutdown",
  );

  const report = window.cancel("shutdown");
  await rejection;

  assert.equal(report.reason, "shutdown");
  assert.equal(report.watermark, -1);
  assert.deepEqual(
    report.retained.map(({ seq, attempts, state }) => ({
      seq,
      attempts,
      state,
    })),
    [
      { seq: 0, attempts: 1, state: "in-flight" },
      { seq: 1, attempts: 1, state: "in-flight" },
      { seq: 2, attempts: 0, state: "pending" },
    ],
  );
  assert.deepEqual(
    report.retained.map(({ value }) => value),
    ["a", "b", "c"],
  );

  assert.equal(window.cancelled, true);
  assert.equal(window.closed, true);
  assert.equal(window.inFlight, 0);
  assert.equal(window.buffered, 0);
  assert.equal(window.poll(), undefined);
  assert.equal(window.cancel("ignored"), report);
  assert.throws(() => window.push("d"), WindowCancelledError);
  assert.throws(() => window.ackSelective(0), WindowCancelledError);
});

test("next() resolves pushed work and honours wait-signal aborts", async () => {
  const window = new DeliveryWindow<string>({ capacity: 1 });
  const first = window.next();
  window.push("a");
  assert.deepEqual(await first, {
    seq: 0,
    value: "a",
    attempt: 1,
    redelivered: false,
  });

  const controller = new AbortController();
  const aborted = window.next(controller.signal);
  controller.abort("stop-waiting");
  await assert.rejects(aborted, (reason: unknown) => reason === "stop-waiting");
});

test("abort signal cancels the whole window", () => {
  const controller = new AbortController();
  const window = new DeliveryWindow<string>({
    capacity: 1,
    signal: controller.signal,
  });
  window.push("a");

  controller.abort("consumer-gone");
  assert.equal(window.cancelled, true);
  assert.equal(window.cancelReason, "consumer-gone");
  assert.throws(() => window.push("b"), WindowCancelledError);
});

test("constructor accepts an already-aborted signal", () => {
  const controller = new AbortController();
  controller.abort("already-gone");
  const window = new DeliveryWindow<string>({
    capacity: 1,
    signal: controller.signal,
  });

  assert.equal(window.cancelled, true);
  assert.equal(window.cancelReason, "already-gone");
  assert.equal(window.poll(), undefined);
});

test("supports a non-zero starting sequence", () => {
  const window = new DeliveryWindow<string>({
    capacity: 2,
    startSeq: 100,
  });
  assert.equal(window.watermark, 99);
  assert.equal(window.push("a"), 100);
  assert.equal(window.push("b"), 101);
  assert.equal(window.poll()?.seq, 100);
  assert.equal(window.poll()?.seq, 101);
  window.ackSelective([101, 100]);
  assert.equal(window.watermark, 101);
  assert.equal(window.releasedThrough, 101);
});
