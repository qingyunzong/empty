import type { Runtime } from "../src/index.js";

/**
 * Shared workload: spawns children dynamically, exercises sleeps, checkpoints,
 * joins, a timeout and a cancellation, so the trace contains every event kind.
 */
export function standardProgram(rt: Runtime): void {
  rt.spawn("producer", async (ctx) => {
    for (let i = 0; i < 3; i++) {
      await ctx.sleep(4 + i);
      ctx.spawn(`worker-${i}`, async (w) => {
        await w.sleep(6, { timeout: 12 });
        await w.checkpoint();
      });
    }
    const tail = ctx.spawn("tail", async (t) => {
      await t.sleep(3);
    });
    await ctx.join(tail);
  });

  const victim = rt.spawn("victim", async (ctx) => {
    try {
      await ctx.sleep(50);
    } catch (err) {
      if (err instanceof Error && err.name === "CancelError") return;
      throw err;
    }
  });

  rt.spawn("killer", async (ctx) => {
    await ctx.sleep(5);
    ctx.cancel(victim);
  });

  rt.spawn("impatient", async (ctx) => {
    try {
      await ctx.sleep(30, { timeout: 9 });
    } catch (err) {
      if (err instanceof Error && err.name !== "TimeoutError") throw err;
    }
    await ctx.checkpoint();
  });
}

/** Same as standardProgram plus one extra task: breaks replay. */
export function mutatedProgram(rt: Runtime): void {
  standardProgram(rt);
  rt.spawn("intruder", async (ctx) => {
    await ctx.checkpoint();
  });
}
