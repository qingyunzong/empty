import { test } from "node:test";
import * as assert from "node:assert/strict";
import { Deferred, Topic, deferred, type Subscription } from "../src/index.js";

/** One macrotask: lets queued microtasks and event-loop turns settle. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function flush(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) await tick();
}

async function collect<T>(sub: Subscription<T>, out: T[]): Promise<void> {
  for await (const value of sub) {
    out.push(value);
    await tick(); // consume slowly so backpressure is exercised
  }
}

test("deferred: controllable promise settles once, observably", async () => {
  const d = deferred<number>();
  assert.equal(d.settled, false);
  d.resolve(41);
  d.resolve(42); // ignored: already settled
  assert.equal(d.settled, true);
  assert.equal(await d.promise, 41);

  const d2 = deferred<number>();
  const boom = new Error("boom");
  d2.reject(boom);
  d2.reject(new Error("ignored"));
  await assert.rejects(d2.promise, (err) => err === boom);
});

test("publish delivers to every subscriber in FIFO order", async () => {
  const topic = new Topic<string>();
  const a = topic.subscribe();
  const b = topic.subscribe({ capacity: 3 });

  for (const m of ["m1", "m2", "m3"]) {
    assert.equal(await topic.publish(m), 2);
  }
  for (const m of ["m1", "m2", "m3"]) {
    assert.equal((await a.next()).value, m);
  }
  for (const m of ["m1", "m2", "m3"]) {
    assert.equal((await b.next()).value, m);
  }
});

test("return() closes only that subscription", async () => {
  const topic = new Topic<number>();
  const s1 = topic.subscribe();
  const s2 = topic.subscribe();

  assert.equal(await topic.publish(1), 2);
  await s1.return();

  assert.equal(s1.closed, true);
  assert.equal((await s1.next()).done, true);
  assert.equal(topic.subscriberCount, 1);

  // The other subscription is unaffected and keeps receiving.
  assert.equal(await topic.publish(2), 1);
  assert.equal((await s2.next()).value, 1);
  assert.equal((await s2.next()).value, 2);

  // for-await break also invokes return() and unsubscribes.
  const s3 = topic.subscribe();
  await topic.publish(3);
  const seen: number[] = [];
  for await (const v of s3) {
    seen.push(v);
    break;
  }
  assert.deepEqual(seen, [3]);
  assert.equal(s3.closed, true);
  assert.equal(topic.subscriberCount, 1);
});

test("a full slow subscriber blocks publish until it consumes", async () => {
  const topic = new Topic<string>();
  const slow = topic.subscribe({ capacity: 1 });
  const fast = topic.subscribe({ capacity: 1 });

  assert.equal(await topic.publish("a"), 2); // both queues now full

  let settled = false;
  const blocked = topic.publish("b").then((n) => {
    settled = true;
    return n;
  });
  await flush();
  assert.equal(settled, false, "publish must block while a subscriber is full");
  assert.equal(slow.pending, 1);
  assert.equal(fast.pending, 1);

  // The fast subscriber keeps up, but the publish stays blocked on the slow one.
  assert.equal((await fast.next()).value, "a");
  await flush();
  assert.equal(settled, false, "still blocked by the slow subscriber");
  assert.equal(fast.pending, 0);

  assert.equal((await slow.next()).value, "a"); // frees one slot
  assert.equal(await blocked, 2);
  assert.equal(settled, true);

  assert.equal((await slow.next()).value, "b");
  assert.equal((await fast.next()).value, "b");
});

test("aborting a blocked publish releases its reservations", async () => {
  const topic = new Topic<string>();
  const s1 = topic.subscribe({ capacity: 1 });
  const s2 = topic.subscribe({ capacity: 1 });
  assert.equal(await topic.publish("x"), 2); // fills both queues
  assert.equal((await s1.next()).value, "x"); // s1 empty; s2 still full

  const controller = new AbortController();
  const outcome = topic
    .publish("m", { signal: controller.signal })
    .then(
      () => "resolved",
      (err: unknown) => `rejected:${(err as Error).name}`,
    );
  await flush();
  assert.equal(s1.pending, 1, "reservation on s1 is held while blocked on s2");

  controller.abort();
  assert.equal(await outcome, "rejected:AbortError");
  await flush();
  assert.equal(s1.pending, 0, "reservation on s1 was released");

  // The released slot is reusable: a new publish reserves it again.
  const p2 = topic.publish("n");
  await flush();
  assert.equal(s1.pending, 1);
  assert.equal((await s2.next()).value, "x"); // unblocks p2
  assert.equal(await p2, 2);

  // s1 received exactly "n" (never the canceled "m"); s2 received "x","n".
  assert.equal((await s1.next()).value, "n");
  assert.equal(s1.pending, 0);
  assert.equal((await s2.next()).value, "n");
  assert.equal(s2.pending, 0);
});

test("publish racing return() does not lose other subscribers' messages", async () => {
  const topic = new Topic<string>();
  const s1 = topic.subscribe({ capacity: 1 });
  const s2 = topic.subscribe({ capacity: 1 });

  assert.equal(await topic.publish("x"), 2);
  assert.equal((await s2.next()).value, "x"); // s2 empty; s1 still full

  const events: string[] = [];
  const pendingNext = s2.next().then((r) => {
    events.push(r.done ? "s2:done" : `s2:${r.value}`);
    return r;
  });
  const published = topic.publish("m").then((n) => {
    events.push(`published:${n}`);
    return n;
  });
  await flush();
  assert.deepEqual(events, [], "publish is blocked on full s1; s2 still waiting");

  await s1.return(); // subscriber exits mid-publish
  assert.equal(await published, 1, "delivered to the remaining subscriber only");
  const r = await pendingNext;
  assert.equal(r.done, false, "s2's pending next() still receives the message");
  if (!r.done) assert.equal(r.value, "m");
  await flush();

  // Termination order: the consumer observed the message before publish resolved.
  assert.deepEqual(events, ["s2:m", "published:1"]);

  // Only s1 was closed; the topic keeps working for s2.
  assert.equal(topic.subscriberCount, 1);
  assert.equal(await topic.publish("y"), 1);
  assert.equal((await s2.next()).value, "y");
});

test("controllable promise gates consumption; delivery counts and termination order", async () => {
  const topic = new Topic<string>();
  const sub = topic.subscribe({ capacity: 2 });
  const gate = new Deferred<void>();
  const events: string[] = [];

  const consumer = (async () => {
    for await (const m of sub) {
      events.push(`recv:${m}`);
      await gate.promise; // park here until the test allows progress
    }
    events.push("consumer:done");
  })();

  assert.equal(await topic.publish("a"), 1);
  assert.equal(await topic.publish("b"), 1);
  await flush();
  assert.deepEqual(events, ["recv:a"], "consumer is parked on the gate");

  await sub.return(); // closes only this subscription; "b" is dropped
  gate.resolve(); // let the consumer proceed
  await consumer;
  assert.deepEqual(events, ["recv:a", "consumer:done"]);
  assert.equal(topic.subscriberCount, 0);
});

test("topic.close() ends consumers gracefully; publish/subscribe after close fail", async () => {
  const topic = new Topic<string>();
  const got1: string[] = [];
  const got2: string[] = [];
  const c1 = collect(topic.subscribe(), got1);
  const c2 = collect(topic.subscribe({ capacity: 1 }), got2);

  await topic.publish("a");
  await topic.publish("b");
  topic.close();

  await Promise.all([c1, c2]);
  assert.deepEqual(got1, ["a", "b"], "buffered messages are drained on close");
  assert.deepEqual(got2, ["a", "b"]);
  assert.equal(topic.subscriberCount, 0);

  await assert.rejects(topic.publish("c"), /closed/);
  assert.throws(() => topic.subscribe(), /closed/);
});

test("exact delivery counts across many messages and mixed capacities", async () => {
  const topic = new Topic<number>();
  const got: number[][] = [];
  const consumers: Promise<void>[] = [];
  for (const capacity of [1, 2, 4]) {
    const sub = topic.subscribe({ capacity });
    const bucket: number[] = [];
    got.push(bucket);
    consumers.push(collect(sub, bucket));
  }

  const expected: number[] = [];
  for (let i = 0; i < 10; i++) {
    expected.push(i);
    assert.equal(await topic.publish(i), 3, `message ${i} delivered to all 3`);
  }
  topic.close();
  await Promise.all(consumers);

  for (const bucket of got) {
    assert.deepEqual(bucket, expected, "every subscriber received all 10 in order");
  }
});

test("concurrent publishes are serialized; each subscriber sees FIFO order", async () => {
  const topic = new Topic<number>();
  const sub = topic.subscribe({ capacity: 3 });
  const received: number[] = [];
  const consumer = collect(sub, received);

  const publishers: Promise<number>[] = [];
  for (let i = 0; i < 6; i++) publishers.push(topic.publish(i));
  const counts = await Promise.all(publishers);
  assert.deepEqual(counts, [1, 1, 1, 1, 1, 1]);

  topic.close();
  await consumer;
  assert.deepEqual(received, [0, 1, 2, 3, 4, 5]);
});

test("a queued publisher can be aborted while another publish is blocked", async () => {
  const topic = new Topic<string>();
  const slow = topic.subscribe({ capacity: 1 });
  assert.equal(await topic.publish("x"), 1); // slow is now full

  const blocked = topic.publish("first"); // holds the lock, waits for slow
  const controller = new AbortController();
  const queued = topic.publish("second", { signal: controller.signal });
  await flush();

  controller.abort();
  await assert.rejects(queued, (err) => (err as Error).name === "AbortError");

  assert.equal((await slow.next()).value, "x");
  assert.equal(await blocked, 1);
  assert.equal((await slow.next()).value, "first");
  assert.equal(slow.pending, 0, "the aborted publish never delivered");
});
