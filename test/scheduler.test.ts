import { test } from "node:test";
import assert from "node:assert/strict";
import { Scheduler, runTree } from "../src/index.js";
import type { TaskFn } from "../src/index.js";

/** 模拟一段异步工作（持有占位期间让出事件循环）。 */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * 手动驱动调度器直到 promise 落定：
 * 每一轮先 pump() 给排队续体授权，再让出事件循环让任务推进。
 */
async function drive<T>(scheduler: Scheduler, promise: Promise<T>): Promise<T> {
  const box: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  promise.then(
    (value) => {
      box.settled = true;
      box.value = value;
    },
    (error) => {
      box.settled = true;
      box.error = error;
    },
  );
  while (!box.settled) {
    scheduler.pump();
    await tick();
  }
  scheduler.pump();
  if ("error" in box) throw box.error;
  return box.value as T;
}

/** 占位账平：没有泄漏也没有排队残留。 */
function assertBooksBalanced(scheduler: Scheduler): void {
  assert.equal(scheduler.active, 0, "no slot may remain held");
  assert.equal(scheduler.pending, 0, "no waiter may remain queued");
  assert.equal(scheduler.totalAcquired, scheduler.totalReleased);
}

test("嵌套深度超过容量仍能完成（capacity=1, depth=6）", async () => {
  const scheduler = new Scheduler({ capacity: 1, manual: true });
  const depth = 6;
  const order: number[] = [];

  const makeLevel = (level: number): TaskFn<number> =>
    async (ctx) => {
      order.push(level);
      await tick(); // 持有占位期间做异步工作
      if (level === depth) return level;
      // 父任务 await 子任务时交还占位，恢复时重新申请
      const child = await ctx.call(makeLevel(level + 1));
      await tick(); // 恢复后仍持有占位继续工作
      return child + level;
    };

  const result = await drive(scheduler, runTree(scheduler, makeLevel(1)));

  assert.equal(result, (depth * (depth + 1)) / 2, "所有层级结果正确聚合");
  assert.deepEqual(order, [1, 2, 3, 4, 5, 6], "逐层深入，未被容量卡死");
  assert.equal(scheduler.maxActive, 1, "在途数从未超过容量 1");
  assertBooksBalanced(scheduler);
});

test("扇出并发不超并行预算且用满预算（capacity=3, 12 个叶子）", async () => {
  const scheduler = new Scheduler({ capacity: 3, manual: true });
  const done: string[] = [];

  const leaf = (name: string): TaskFn<string> =>
    async () => {
      await tick(); // 持有占位跨事件循环，制造真实并发窗口
      await tick();
      done.push(name);
      return name;
    };

  const root: TaskFn<string[]> = async (ctx) => {
    const branches = await ctx.all([
      (c1) => c1.all([leaf("a1"), leaf("a2"), leaf("a3"), leaf("a4")]),
      (c2) => c2.all([leaf("b1"), leaf("b2"), leaf("b3"), leaf("b4")]),
      (c3) => c3.all([leaf("c1"), leaf("c2"), leaf("c3"), leaf("c4")]),
    ]);
    return branches.flat();
  };

  const result = await drive(scheduler, runTree(scheduler, root));

  assert.equal(result.length, 12);
  assert.equal(done.length, 12, "全部叶子完成");
  assert.ok(scheduler.maxActive <= 3, `在途峰值 ${scheduler.maxActive} 不超过预算 3`);
  assert.equal(scheduler.maxActive, 3, "预算被用满，调度器没有过度串行化");
  assertBooksBalanced(scheduler);
});

test("深层子任务抛异常：错误冒泡且全部占位被清理", async () => {
  const scheduler = new Scheduler({ capacity: 2, manual: true });
  const boom = new Error("boom at leaf");

  const leaf: TaskFn<never> = async () => {
    await tick();
    throw boom;
  };
  const mid: TaskFn<number> = async (ctx) => {
    // 扇出中一个分支失败，其余兄弟仍会跑完并释放占位
    const results = await ctx.all([
      leaf,
      async () => {
        await tick();
        return 42;
      },
    ]);
    return results[1];
  };
  const root: TaskFn<number> = async (ctx) => ctx.call(mid);

  await assert.rejects(drive(scheduler, runTree(scheduler, root)), (err) => err === boom);
  assertBooksBalanced(scheduler);
});

test("恢复执行必须重新申请占位（capacity=1 时父任务恢复让位于排队者）", async () => {
  const scheduler = new Scheduler({ capacity: 1, manual: true });
  const events: string[] = [];

  const child: TaskFn<string> = async () => {
    events.push("child-run");
    await tick();
    return "child-done";
  };
  const parent: TaskFn<string> = async (ctx) => {
    events.push("parent-start");
    const r = await ctx.call(child); // 交还占位
    events.push("parent-resumed"); // 恢复前已重新申请到占位
    return r;
  };

  const result = await drive(scheduler, runTree(scheduler, parent));

  assert.equal(result, "child-done");
  assert.deepEqual(events, ["parent-start", "child-run", "parent-resumed"]);
  assert.equal(scheduler.maxActive, 1);
  // 进入 3 次（parent enter、child enter、parent resume），释放 3 次
  assert.equal(scheduler.totalAcquired, 3);
  assert.equal(scheduler.totalReleased, 3);
  assertBooksBalanced(scheduler);
});
