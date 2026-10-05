/**
 * A Scheduler decides when woken-up continuations actually run.
 * The library only routes slot grants through the scheduler, so a
 * ManualScheduler gives tests full deterministic control over the
 * order in which queued executions enter the tree.
 */
export interface Scheduler {
  schedule(task: () => void): void;
}

/** Default scheduler for production use: defers to the next macrotask. */
export const immediateScheduler: Scheduler = {
  schedule(task) {
    setImmediate(task);
  },
};

/** Flushes the microtask queue by yielding to the event loop once. */
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Fully manual scheduler: scheduled tasks queue up and only run when
 * the driver calls step() or drain(). If drain() empties the queue while
 * the promise under test is still pending, the tree is deadlocked.
 */
export class ManualScheduler implements Scheduler {
  private readonly queue: Array<() => void> = [];
  private ranCount = 0;

  get pendingCount(): number {
    return this.queue.length;
  }

  get ranTotal(): number {
    return this.ranCount;
  }

  schedule(task: () => void): void {
    this.queue.push(task);
  }

  /** Runs the oldest queued task, if any. Returns false when idle. */
  step(): boolean {
    const task = this.queue.shift();
    if (task === undefined) {
      return false;
    }
    this.ranCount += 1;
    task();
    return true;
  }

  /**
   * Runs queued tasks one at a time, flushing microtasks after each,
   * until the queue is empty and no microtask enqueues more work.
   */
  async drain(): Promise<void> {
    for (;;) {
      while (this.step()) {
        await flushMicrotasks();
      }
      await flushMicrotasks();
      if (this.pendingCount === 0) {
        return;
      }
    }
  }
}
