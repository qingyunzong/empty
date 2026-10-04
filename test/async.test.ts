import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CyclicWaitError,
  EventBus,
  PublishAggregateError,
  type Subscription,
} from "../src/event-bus";

const ticks = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: unknown;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`deadlock suspected: ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

test("async publish: a callback may await and then reentrantly publish", async () => {
  const bus = new EventBus();
  const calls: string[] = [];
  bus.subscribe("t", async (_payload, ctx) => {
    calls.push(`enter:${ctx.depth}`);
    if (ctx.depth === 0) {
      await ticks(3); // await first, then reenter
      await bus.publish("t", undefined);
    }
    calls.push(`exit:${ctx.depth}`);
  });
  await bus.publish("t", undefined);
  assert.deepEqual(calls, ["enter:0", "enter:1", "exit:1", "exit:0"]);
  assert.equal(bus.inFlightCount, 0);
});

test("parent publish waits for derived publishes it never awaited", async () => {
  const bus = new EventBus();
  let childDone = false;
  bus.subscribe("parent", () => {
    void bus.publish("child", undefined); // fire-and-forget derived publish
  });
  bus.subscribe("child", async () => {
    await ticks(5);
    childDone = true;
  });
  await bus.publish("parent", undefined);
  assert.equal(childDone, true);
  assert.equal(bus.inFlightCount, 0);
});

test("errors of fire-and-forget derived publishes merge into the root in tree order", async () => {
  const bus = new EventBus();
  bus.subscribe("parent", () => {
    void bus.publish("child", undefined);
    throw new Error("parent-error");
  });
  bus.subscribe("child", () => {
    throw new Error("child-error");
  });
  await assert.rejects(
    bus.publish("parent", undefined),
    (error: unknown) =>
      error instanceof PublishAggregateError &&
      error.errors.length === 2 &&
      (error.errors[0] as Error).message === "parent-error" &&
      (error.errors[1] as Error).message === "child-error",
  );
});

test("removal with wait blocks until in-flight callbacks finish", async () => {
  const bus = new EventBus();
  const seen: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sub = bus.subscribe("t", async () => {
    seen.push("start");
    await gate;
    seen.push("end");
  });
  const publish = bus.publish("t", undefined);
  const removal = sub.unsubscribe({ wait: true });
  let removalDone = false;
  void removal.then(() => {
    removalDone = true;
  });
  await ticks(5);
  assert.equal(removalDone, false); // still waiting for the in-flight callback
  release();
  await withTimeout(removal, 1000, "removal waits for in-flight callback");
  assert.equal(removalDone, true);
  await publish;
  assert.deepEqual(seen, ["start", "end"]);
  assert.equal(bus.inFlightCount, 0);
});

test("a callback removing its own subscription with wait does not self-wait", async () => {
  const bus = new EventBus();
  const seen: string[] = [];
  let sub!: Subscription;
  sub = bus.subscribe("t", async () => {
    seen.push("run");
    await sub.unsubscribe({ wait: true });
    seen.push("after");
  });
  await withTimeout(bus.publish("t", undefined), 1000, "self-removal");
  assert.deepEqual(seen, ["run", "after"]);
  assert.equal(sub.active, false);
  await bus.publish("t", undefined); // subscription is gone
  assert.deepEqual(seen, ["run", "after"]);
});

test("removal with wait never waits on ancestors of the current invocation", async () => {
  const bus = new EventBus();
  const order: string[] = [];
  let subA!: Subscription;
  subA = bus.subscribe("a", async () => {
    order.push("A:start");
    await bus.publish("b", undefined);
    order.push("A:end");
  });
  bus.subscribe("b", async () => {
    order.push("B:start");
    // A's invocation is an ancestor of this one; waiting on it would deadlock.
    await subA.unsubscribe({ wait: true });
    order.push("B:end");
  });
  await withTimeout(bus.publish("a", undefined), 1000, "ancestor removal");
  assert.deepEqual(order, ["A:start", "B:start", "B:end", "A:end"]);
});

test("a cyclic wait between concurrent callbacks throws instead of deadlocking", async () => {
  const bus = new EventBus();
  let subX!: Subscription;
  let subY!: Subscription;
  subX = bus.subscribe("t1", async () => {
    await ticks(2);
    await subY.unsubscribe({ wait: true });
  });
  subY = bus.subscribe("t2", async () => {
    await ticks(1);
    await subX.unsubscribe({ wait: true });
  });
  const p1 = bus.publish("t1", undefined);
  const p2 = bus.publish("t2", undefined);
  const [r1, r2] = await withTimeout(
    Promise.allSettled([p1, p2]),
    1000,
    "cyclic wait",
  );
  // Y started waiting on X first; X's wait on Y closes the cycle and fails.
  assert.equal(r1?.status, "rejected");
  const reason = (r1 as PromiseRejectedResult).reason;
  assert.ok(reason instanceof PublishAggregateError);
  assert.ok(reason.errors[0] instanceof CyclicWaitError);
  assert.equal(r2?.status, "fulfilled");
  assert.equal(bus.inFlightCount, 0);
});

test("async publish keeps snapshot semantics across awaits", async () => {
  const bus = new EventBus();
  const calls: string[] = [];
  bus.subscribe("t", async () => {
    calls.push("first");
    await ticks(2);
    bus.subscribe("t", async () => {
      calls.push("added");
    });
  });
  await bus.publish("t", undefined);
  assert.deepEqual(calls, ["first"]);
  await bus.publish("t", undefined);
  assert.deepEqual(calls, ["first", "first", "added"]);
});
