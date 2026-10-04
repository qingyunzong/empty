import { Scheduler } from "./scheduler.js";

/** 任务函数：接收任务上下文，返回 Promise。 */
export type TaskFn<R> = (ctx: TaskContext) => Promise<R>;

interface TaskHandle<R> {
  promise: Promise<R>;
}

/**
 * 任务上下文。每个任务持有一个 ctx，任何时刻最多占有一个占位：
 *
 * - 任务开始执行前必须 acquire 占位；
 * - `call` / `all` 等待子任务时先交还自己的占位（suspend），
 *   子任务全部落定后再重新申请占位恢复执行（resume）；
 * - 任务正常返回或抛异常，finally 都会释放其占位（exit），
 *   因此异常会沿调用链逐层清理全部占位。
 */
export class TaskContext {
  private holding = false;

  constructor(private readonly scheduler: Scheduler) {}

  // 以下 enter/exit 为内部生命周期方法，由 runTask 驱动，业务代码请勿直接调用。

  async enter(): Promise<void> {
    await this.scheduler.acquire();
    this.holding = true;
  }

  exit(): void {
    if (this.holding) {
      this.scheduler.release();
      this.holding = false;
    }
  }

  /** 交还占位，让出的容量可立即被子任务使用，避免深度 > 容量时死锁。 */
  private suspend(): void {
    this.exit();
  }

  /** 恢复执行前重新申请占位，可能排队等待。 */
  private async resume(): Promise<void> {
    await this.scheduler.acquire();
    this.holding = true;
  }

  /** 顺序调用一个子任务：交还占位 -> 子任务运行 -> 重新申请占位 -> 返回结果。 */
  async call<R>(fn: TaskFn<R>): Promise<R> {
    this.suspend();
    const child = runTask(this.scheduler, fn);
    try {
      return await child.promise;
    } finally {
      await this.resume();
    }
  }

  /**
   * 并发扇出一组子任务：父任务只交还一次占位，子任务各自申请占位并行运行。
   * 任何子任务失败都会等全部子任务落定（占位清理干净）后再向上抛出。
   */
  async all<T extends readonly TaskFn<unknown>[]>(
    fns: readonly [...T],
  ): Promise<{ [K in keyof T]: T[K] extends TaskFn<infer R> ? R : never }> {
    this.suspend();
    const children = fns.map((fn) => runTask(this.scheduler, fn));
    const settled = await Promise.allSettled(children.map((c) => c.promise));
    await this.resume();
    const rejected = settled.find((s) => s.status === "rejected");
    if (rejected) throw (rejected as PromiseRejectedResult).reason;
    return settled.map(
      (s) => (s as PromiseFulfilledResult<unknown>).value,
    ) as { [K in keyof T]: T[K] extends TaskFn<infer R> ? R : never };
  }
}

function runTask<R>(scheduler: Scheduler, fn: TaskFn<R>): TaskHandle<R> {
  const ctx = new TaskContext(scheduler);
  const promise = (async (): Promise<R> => {
    await ctx.enter();
    try {
      return await fn(ctx);
    } finally {
      // 正常返回或异常冒泡都会走到这里，保证占位被释放。
      ctx.exit();
    }
  })();
  // 占位防护：父任务统一通过 await / allSettled 接收子任务结果，
  // 这里避免在父任务挂载处理器之前的窗口期触发 unhandledRejection。
  promise.catch(() => {});
  return { promise };
}

/** 以 scheduler 的容量预算运行一整棵调用树。 */
export function runTree<R>(scheduler: Scheduler, fn: TaskFn<R>): Promise<R> {
  return runTask(scheduler, fn).promise;
}
