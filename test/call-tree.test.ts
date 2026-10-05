import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CallTree,
  ManualScheduler,
  runTree,
  type TreeFn,
} from "../src/index.js";

/**
 * Drives the manual scheduler until the promise settles. If the scheduler
 * runs out of work while the promise is still pending, the call tree is
 * deadlocked (e.g. a frame forgot to yield its slot while awaiting).
 */
async function drainUntilSettled(
  scheduler: ManualScheduler,
  promise: Promise<unknown>,
): Promise<void> {
  let settled = false;
  const mark = (): void => {
    settled = true;
  };
  promise.then(mark, mark);
  for (;;) {
    await scheduler.drain();
    if (settled) {
      return;
    }
    if (scheduler.pendingCount === 0) {
      assert.fail("deadlock: scheduler idle but the call tree never settled");
    }
  }
}

/** Builds a chain that nests via ctx.spawn until it reaches maxDepth. */
function nestedChain(maxDepth: number): TreeFn<number> {
  const level: TreeFn<number> = (ctx) => {
    if (ctx.depth >= maxDepth) {
      return ctx.depth;
    }
    return ctx.spawn(level);
  };
  return level;
}

test("嵌套深度超过容量仍能完成且不超并行预算（深度 12，容量 2）", async () => {
  const scheduler = new ManualScheduler();
  const tree = new CallTree(2, scheduler);

  const promise = runTree(tree, nestedChain(12));
  await drainUntilSettled(scheduler, promise);

  assert.equal(await promise, 12);
  assert.ok(tree.maxObserved <= tree.capacity, "parallelism budget exceeded");
  assert.equal(tree.inFlight, 0, "slots leaked after completion");
  assert.equal(tree.waiting, 0, "waiters leaked after completion");
});

test("容量为 1 时任意深度仍可完成（await 子任务必须交还占位）", async () => {
  const scheduler = new ManualScheduler();
  const tree = new CallTree(1, scheduler);

  // With capacity 1 this deadlocks unless the parent yields its slot
  // while awaiting each child; drainUntilSettled fails the test then.
  const promise = runTree(tree, nestedChain(8));
  await drainUntilSettled(scheduler, promise);

  assert.equal(await promise, 8);
  assert.equal(tree.maxObserved, 1);
  assert.equal(tree.inFlight, 0);
});

test("父函数恢复时重新申请占位（acquire 计数 = 帧数 + 恢复数）", async () => {
  const scheduler = new ManualScheduler();
  const tree = new CallTree(3, scheduler);
  const depth = 5;

  const promise = runTree(tree, nestedChain(depth));
  await drainUntilSettled(scheduler, promise);
  assert.equal(await promise, depth);

  // depth + 1 frames each acquire once; each of the depth awaits
  // re-acquires the parent slot exactly once on resume.
  assert.equal(tree.totalAcquires, 2 * depth + 1);
  assert.equal(tree.inFlight, 0);
});

test("异常沿调用树传播时清理全部占位", async () => {
  const scheduler = new ManualScheduler();
  const tree = new CallTree(2, scheduler);
  const boom = new Error("boom");

  const exploding: TreeFn<number> = (ctx) => {
    if (ctx.depth === 6) {
      throw boom;
    }
    return ctx.spawn(exploding);
  };

  const promise = runTree(tree, exploding);
  const guarded = promise.catch((error: unknown) => error);
  await drainUntilSettled(scheduler, promise);

  assert.equal(await guarded, boom);
  assert.equal(tree.inFlight, 0, "exception left slots held");
  assert.equal(tree.waiting, 0, "exception left waiters queued");

  // The tree stays usable after the failure.
  const again = runTree(tree, nestedChain(3));
  await drainUntilSettled(scheduler, again);
  assert.equal(await again, 3);
  assert.equal(tree.inFlight, 0);
});

test("并发扇出不超并行预算（容量 3，3 叉扇出深度 3）", async () => {
  const scheduler = new ManualScheduler();
  const tree = new CallTree(3, scheduler);

  const fanout: TreeFn<number> = async (ctx) => {
    if (ctx.depth === 3) {
      return 1;
    }
    const children = await Promise.all([
      ctx.spawn(fanout),
      ctx.spawn(fanout),
      ctx.spawn(fanout),
    ]);
    return 1 + children.reduce((sum, value) => sum + value, 0);
  };

  const promise = runTree(tree, fanout);
  await drainUntilSettled(scheduler, promise);

  assert.equal(await promise, 40); // 1 + 3 + 9 + 27 frames
  assert.ok(tree.maxObserved <= tree.capacity, "parallelism budget exceeded");
  assert.equal(tree.maxObserved, 3, "budget was never fully used");
  assert.equal(tree.inFlight, 0);
  assert.equal(tree.waiting, 0);
});

test("默认调度器（setImmediate）下也能跑通", async () => {
  const tree = new CallTree(2);
  const result = await runTree(tree, nestedChain(10));
  assert.equal(result, 10);
  assert.ok(tree.maxObserved <= 2);
  assert.equal(tree.inFlight, 0);
});
