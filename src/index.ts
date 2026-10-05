/**
 * KeyedSerialQueue — 每键串行任务队列。
 *
 * - 同一 key 的任务严格按提交顺序串行执行；不同 key 之间完全并行。
 * - 任务回调内部再次向同一 key 提交时，新任务排到当前任务之后，不会死锁。
 * - 任务可以同步返回值或返回 Promise，顺序语义一致。
 * - 某个任务抛错只会拒绝它自己的 Promise，不影响同 key 后续任务。
 * - close() 之后拒绝新提交；可选择排空（drain）已排队任务，或取消尚未开始的任务。
 */

export type Task<T> = () => T | Promise<T>;

export class QueueClosedError extends Error {
  constructor(message = 'Queue is closed; new submissions are rejected') {
    super(message);
    this.name = 'QueueClosedError';
  }
}

export class TaskCancelledError extends Error {
  constructor(message = 'Task was cancelled before it started') {
    super(message);
    this.name = 'TaskCancelledError';
  }
}

export interface CloseOptions {
  /**
   * true：取消所有尚未开始的任务（它们的 Promise 以 TaskCancelledError 拒绝）；
   * false（默认）：排空，已排队任务继续执行完毕。
   */
  cancelPending?: boolean;
}

interface PendingItem {
  cancelled: boolean;
}

export class KeyedSerialQueue {
  private chains = new Map<string, Promise<void>>();
  private pending = new Set<PendingItem>();
  private closed = false;

  /** 队列是否已关闭。 */
  get isClosed(): boolean {
    return this.closed;
  }

  /** 当前已排队（含正在执行）的任务数。 */
  get size(): number {
    return this.pending.size;
  }

  /**
   * 提交一个任务到指定 key 的串行队列。
   * 返回的 Promise 在该任务实际执行完成后兑现/拒绝。
   */
  submit<T>(key: string, task: Task<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new QueueClosedError());
    }

    const item: PendingItem = { cancelled: false };
    this.pending.add(item);

    let resolveResult!: (value: T) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    const previous = this.chains.get(key) ?? Promise.resolve();
    // previous 链上的任务永不拒绝（错误已被捕获并转给各自的 result），
    // 因此这里直接接续即可保证同 key 严格串行。
    const run = previous.then(async () => {
      this.pending.delete(item);
      if (item.cancelled) {
        rejectResult(new TaskCancelledError());
        return;
      }
      try {
        // await 同时兼容同步返回值与 Promise，顺序语义一致。
        resolveResult(await task());
      } catch (error) {
        rejectResult(error);
      }
    });

    this.chains.set(key, run);
    // 链尾 settle 后清理空链，避免 Map 无限增长。
    void run.finally(() => {
      if (this.chains.get(key) === run) {
        this.chains.delete(key);
      }
    });

    return result;
  }

  /**
   * 关闭队列：立即拒绝后续 submit。
   * 返回的 Promise 在所有已接受的任务（执行中 + 已排队）结束后兑现。
   * cancelPending: true 时，尚未开始的任务不执行，直接以 TaskCancelledError 拒绝。
   */
  close(options: CloseOptions = {}): Promise<void> {
    this.closed = true;
    if (options.cancelPending) {
      for (const item of this.pending) {
        item.cancelled = true;
      }
    }
    return this.onIdle();
  }

  /** 当前所有 key 的链都执行完毕时兑现。 */
  onIdle(): Promise<void> {
    return Promise.all([...this.chains.values()]).then(() => undefined);
  }
}
