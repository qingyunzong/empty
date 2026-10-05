export interface Executor {
  submit<T>(label: string, task: () => Promise<T> | T): Promise<T>;
}

/** Default executor: runs tasks immediately, bounded by a concurrency limit. */
export class ImmediateExecutor implements Executor {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly concurrency = 8) {
    if (concurrency < 1) throw new Error("concurrency must be >= 1");
  }

  submit<T>(_label: string, task: () => Promise<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(() => {
        this.active++;
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            this.pump();
          });
      });
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

interface PendingTask {
  label: string;
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

/**
 * Fully controllable executor for deterministic tests: tasks are queued, and
 * the caller decides exactly when each one runs via `step()`/`drain()`.
 * Dropping the instance mid-queue simulates a power cut between stages.
 */
export class ManualExecutor implements Executor {
  private readonly tasks: PendingTask[] = [];

  submit<T>(label: string, task: () => Promise<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.tasks.push({
        label,
        task: task as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
    });
  }

  pending(): string[] {
    return this.tasks.map((t) => t.label);
  }

  /** Run the next queued task to completion; returns its label (or null). */
  async step(): Promise<string | null> {
    const next = this.tasks.shift();
    if (!next) return null;
    try {
      next.resolve(await next.task());
    } catch (err) {
      next.reject(err);
    }
    return next.label;
  }

  /** Run tasks until the queue is (transitively) empty. */
  async drain(): Promise<void> {
    while (this.tasks.length > 0) {
      await this.step();
      await Promise.resolve();
    }
  }
}
