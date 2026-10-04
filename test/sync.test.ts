import assert from "node:assert/strict";
import { test } from "node:test";
import { EventBus, PublishAggregateError } from "../src/event-bus";

test("snapshot: subscriptions added during a publish only affect later publishes", () => {
  const bus = new EventBus();
  const calls: string[] = [];
  bus.subscribe("t", () => {
    calls.push("first");
    bus.subscribe("t", () => {
      calls.push("added");
    });
  });
  bus.publishSync("t", 1);
  assert.deepEqual(calls, ["first"]);
  bus.publishSync("t", 1);
  assert.deepEqual(calls, ["first", "first", "added"]);
});

test("snapshot: a subscription removed during a publish still runs in that publish", () => {
  const bus = new EventBus();
  const calls: string[] = [];
  let second!: ReturnType<EventBus["subscribe"]>;
  bus.subscribe("t", () => {
    calls.push("first");
    second.unsubscribe();
  });
  second = bus.subscribe("t", () => {
    calls.push("second");
  });
  bus.publishSync("t", 1);
  assert.deepEqual(calls, ["first", "second"]);
  bus.publishSync("t", 1);
  assert.deepEqual(calls, ["first", "second", "first"]);
});

test("one subscription runs exactly once per publish even with reentrant publish", () => {
  const bus = new EventBus();
  const perPublish = new Map<number, number>();
  bus.subscribe("t", (_payload, ctx) => {
    perPublish.set(ctx.publishId, (perPublish.get(ctx.publishId) ?? 0) + 1);
    if (ctx.depth < 2) bus.publishSync(ctx.topic, undefined);
  });
  bus.publishSync("t", undefined);
  assert.equal(perPublish.size, 3); // depths 0, 1, 2
  for (const count of perPublish.values()) assert.equal(count, 1);
});

test("errors are aggregated in publish-tree order and never block other callbacks", () => {
  const bus = new EventBus();
  const calls: string[] = [];
  bus.subscribe("t", () => {
    calls.push("A");
    throw new Error("e1");
  });
  bus.subscribe("t", () => {
    calls.push("B");
    bus.publishSync("nested", undefined); // nested subtree fails -> propagates
  });
  bus.subscribe("t", () => {
    calls.push("D");
    throw new Error("e3");
  });
  bus.subscribe("nested", () => {
    calls.push("C");
    throw new Error("e2");
  });
  let caught: unknown;
  try {
    bus.publishSync("t", undefined);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof PublishAggregateError);
  assert.deepEqual(calls, ["A", "B", "C", "D"]);
  assert.deepEqual(
    (caught as PublishAggregateError).errors.map((e) => (e as Error).message),
    ["e1", "e2", "e3"],
  );
});

test("publishSync reports async handlers as aggregated errors and continues", () => {
  const bus = new EventBus();
  const calls: string[] = [];
  bus.subscribe("t", () => {
    calls.push("async");
    return Promise.resolve();
  });
  bus.subscribe("t", () => {
    calls.push("sync");
  });
  assert.throws(
    () => bus.publishSync("t", 1),
    (error: unknown) =>
      error instanceof PublishAggregateError &&
      /returned a Promise/.test((error.errors[0] as Error).message),
  );
  assert.deepEqual(calls, ["async", "sync"]);
});

test("a subscription cancelled before the next publish never runs again", () => {
  const bus = new EventBus();
  const calls: string[] = [];
  const sub = bus.subscribe("t", () => {
    calls.push("x");
  });
  sub.unsubscribe();
  bus.publishSync("t", 1);
  assert.deepEqual(calls, []);
  assert.equal(sub.active, false);
});
