import { Scheduler, TaskContext, TimeoutError } from "../src/scheduler";

/**
 * Shared demo workload used by the determinism / replay / snapshot tests.
 *
 * Exercises every recorded event kind:
 *  - register/schedule: plain checkpoints and sleeps
 *  - timeout: worker-b's sleep(20, { timeout: 12 }) loses the race
 *  - cancel: canceller cancels victim mid-sleep
 *  - complete: worker-a, worker-b, canceller finish normally
 */
export function registerDemoTasks(scheduler: Scheduler): void {
  scheduler.spawn("worker-a", async (ctx: TaskContext) => {
    await ctx.checkpoint("init");
    await ctx.sleep(10);
    const r = ctx.random();
    await ctx.checkpoint("after-random");
    if (r < 0.5) {
      await ctx.sleep(5, { label: "short-nap" });
    }
  });

  scheduler.spawn("worker-b", async (ctx: TaskContext) => {
    await ctx.sleep(5, { label: "warmup" });
    await ctx.checkpoint();
    try {
      await ctx.sleep(20, { timeout: 12, label: "long-poll" });
    } catch (err) {
      if (!(err instanceof TimeoutError)) throw err;
    }
    await ctx.checkpoint("after-timeout");
  });

  scheduler.spawn("canceller", async (ctx: TaskContext) => {
    await ctx.sleep(3, { label: "fuse" });
    ctx.cancelTask("victim");
    await ctx.checkpoint("done-cancelling");
  });

  scheduler.spawn("victim", async (ctx: TaskContext) => {
    await ctx.checkpoint("victim-init");
    await ctx.sleep(50, { label: "forever" });
  });
}

export function demoScheduler(seed: number): Scheduler {
  const scheduler = new Scheduler({ seed });
  registerDemoTasks(scheduler);
  return scheduler;
}
