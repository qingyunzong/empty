import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import {
  ExecutorClosedError,
  KeyedSerialExecutor,
  TaskCancelledError,
} from "../src/keyed-serial.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("KeyedSerialExecutor", () => {
  test("same key runs serially in submission order, mixing sync and async completion", async () => {
    const executor = new KeyedSerialExecutor();
    const events: string[] = [];
    let concurrency = 0;
    let maxConcurrency = 0;

    const delays = [30, 0, 20, 0, 10]; // 0ms => effectively synchronous completion
    const promises = delays.map((ms, index) =>
      executor.submit("alpha", async () => {
        concurrency += 1;
        maxConcurrency = Math.max(maxConcurrency, concurrency);
        events.push(`start:${index}`);
        if (ms > 0) await sleep(ms);
        events.push(`end:${index}`);
        concurrency -= 1;
        return index;
      }),
    );

    const results = await Promise.all(promises);
    assert.deepEqual(results, [0, 1, 2, 3, 4]);
    assert.equal(maxConcurrency, 1, "same key must never overlap");
    assert.deepEqual(events, [
      "start:0", "end:0",
      "start:1", "end:1",
      "start:2", "end:2",
      "start:3", "end:3",
      "start:4", "end:4",
    ]);
    await executor.close();
  });

  test("different keys run in parallel", async () => {
    const executor = new KeyedSerialExecutor();
    let concurrency = 0;
    let maxConcurrency = 0;

    const makeTask = () => async () => {
      concurrency += 1;
      maxConcurrency = Math.max(maxConcurrency, concurrency);
      await sleep(40);
      concurrency -= 1;
    };

    await Promise.all([
      executor.submit("k1", makeTask()),
      executor.submit("k2", makeTask()),
      executor.submit("k3", makeTask()),
    ]);
    assert.equal(maxConcurrency, 3, "distinct keys should overlap");
    await executor.close();
  });

  test("re-entrant submit on the same key queues behind the current task instead of deadlocking", { timeout: 5000 }, async () => {
    const executor = new KeyedSerialExecutor();
    const order: string[] = [];
    let inner: Promise<string> | undefined;

    const outer = executor.submit("reentry", async () => {
      order.push("outer:start");
      // Submit more work for the SAME key from inside a running task.
      // It must be scheduled after this task, not awaited in place.
      inner = executor.submit("reentry", () => {
        order.push("inner");
        return "inner-result";
      });
      await sleep(10);
      order.push("outer:end");
      return "outer-result";
    });

    assert.equal(await outer, "outer-result");
    assert.equal(await inner, "inner-result");
    assert.deepEqual(order, ["outer:start", "outer:end", "inner"]);
    await executor.close();
  });

  test("a throwing task rejects its own promise but does not block later tasks", async () => {
    const executor = new KeyedSerialExecutor();
    const order: string[] = [];
    const boom = new Error("boom");

    const failing = executor.submit("k", () => {
      order.push("failing");
      throw boom;
    });
    const rejectingAsync = executor.submit("k", async () => {
      order.push("rejectingAsync");
      await sleep(5);
      throw new Error("async boom");
    });
    const survivor = executor.submit("k", () => {
      order.push("survivor");
      return "ok";
    });

    await assert.rejects(failing, (err: unknown) => err === boom);
    await assert.rejects(rejectingAsync, /async boom/);
    assert.equal(await survivor, "ok");
    assert.deepEqual(order, ["failing", "rejectingAsync", "survivor"]);
    await executor.close();
  });

  test("close() rejects new submissions", async () => {
    const executor = new KeyedSerialExecutor();
    await executor.close();
    assert.equal(executor.isClosed, true);
    await assert.rejects(executor.submit("k", () => 1), ExecutorClosedError);
  });

  test("close() drains queued tasks by default", async () => {
    const executor = new KeyedSerialExecutor();
    const finished: number[] = [];

    const promises = [0, 1, 2].map((i) =>
      executor.submit("drain", async () => {
        await sleep(15);
        finished.push(i);
      }),
    );

    const closing = executor.close();
    assert.equal(executor.isClosed, true);
    await closing;
    await Promise.all(promises);
    assert.deepEqual(finished, [0, 1, 2], "every queued task ran before close resolved");
  });

  test("close({ cancelPending: true }) cancels not-yet-started tasks but lets the running one finish", async () => {
    const executor = new KeyedSerialExecutor();
    const started: string[] = [];
    const finished: string[] = [];

    const running = executor.submit("k", async () => {
      started.push("running");
      await sleep(30);
      finished.push("running");
    });
    const queued1 = executor.submit("k", () => {
      started.push("queued1");
    });
    const queued2 = executor.submit("k", () => {
      started.push("queued2");
    });
    // Attach rejection handlers up front: cancellation rejects these
    // promises synchronously inside close().
    const cancelled1 = assert.rejects(queued1, TaskCancelledError);
    const cancelled2 = assert.rejects(queued2, TaskCancelledError);

    await sleep(5); // let the first task start
    await executor.close({ cancelPending: true });

    await running;
    await cancelled1;
    await cancelled2;
    assert.deepEqual(started, ["running"], "cancelled tasks must never start");
    assert.deepEqual(finished, ["running"], "the running task still completed");
  });
});
