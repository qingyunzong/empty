export class ExecutorClosedError extends Error {
  constructor(message = "KeyedSerialExecutor is closed; new submissions are rejected") {
    super(message);
    this.name = "ExecutorClosedError";
  }
}

export class TaskCancelledError extends Error {
  constructor(message = "Task was cancelled before it started") {
    super(message);
    this.name = "TaskCancelledError";
  }
}

export type Task<T> = () => T | Promise<T>;

export interface CloseOptions {
  /**
   * false (default): wait for every queued and running task to finish (drain).
   * true: tasks that have not started yet are cancelled and their promises
   * reject with TaskCancelledError; already-running tasks still finish.
   */
  cancelPending?: boolean;
}

interface QueueEntry {
  task: Task<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/**
 * Runs tasks submitted under the same key strictly one at a time, in
 * submission order, while tasks under different keys run concurrently.
 *
 * A task may submit more work for its own key (or any other key); such work
 * is simply appended to the key's queue and runs after the current task,
 * so re-entrant submission never deadlocks.
 *
 * A task that throws (or returns a rejected promise) rejects only its own
 * submission promise; the rest of the key's queue keeps going.
 */
export class KeyedSerialExecutor {
  private readonly queues = new Map<string, QueueEntry[]>();
  private readonly busyKeys = new Set<string>();
  private closed = false;
  private inflight = 0;
  private idleWaiters: Array<() => void> = [];

  get isClosed(): boolean {
    return this.closed;
  }

  /** Number of tasks currently executing (across all keys). */
  get runningCount(): number {
    return this.inflight;
  }

  /** Number of queued, not-yet-started tasks (across all keys, or one key). */
  pendingCount(key?: string): number {
    if (key !== undefined) {
      return this.queues.get(key)?.length ?? 0;
    }
    let total = 0;
    for (const queue of this.queues.values()) total += queue.length;
    return total;
  }

  submit<T>(key: string, task: Task<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new ExecutorClosedError());
    }
    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = {
        task: task as Task<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      let queue = this.queues.get(key);
      if (queue === undefined) {
        queue = [];
        this.queues.set(key, queue);
      }
      queue.push(entry);
      this.pump(key);
    });
  }

  /**
   * Stop accepting submissions. Resolves once no work remains, according to
   * `options.cancelPending` (see CloseOptions).
   */
  async close(options: CloseOptions = {}): Promise<void> {
    this.closed = true;
    if (options.cancelPending === true) {
      for (const queue of this.queues.values()) {
        for (const entry of queue) {
          entry.reject(new TaskCancelledError());
        }
        queue.length = 0;
      }
      this.queues.clear();
    }
    while (this.inflight > 0 || this.pendingCount() > 0) {
      await new Promise<void>((wake) => this.idleWaiters.push(wake));
    }
  }

  private pump(key: string): void {
    if (this.busyKeys.has(key)) return;
    const queue = this.queues.get(key);
    if (queue === undefined || queue.length === 0) {
      this.queues.delete(key);
      this.wakeIfIdle();
      return;
    }
    this.busyKeys.add(key);
    const entry = queue.shift()!;
    this.inflight += 1;
    void (async () => {
      try {
        entry.resolve(await entry.task());
      } catch (error) {
        entry.reject(error);
      } finally {
        this.inflight -= 1;
        this.busyKeys.delete(key);
        this.pump(key);
        this.wakeIfIdle();
      }
    })();
  }

  private wakeIfIdle(): void {
    if (this.inflight > 0 || this.pendingCount() > 0) return;
    const waiters = this.idleWaiters.splice(0);
    for (const wake of waiters) wake();
  }
}
