/**
 * A controllable executor for asynchronous work.
 *
 * Submitted tasks do not run until explicitly completed by the caller, and
 * they may be completed in ANY order. This simulates an async backend whose
 * queries finish out of order, which is exactly the condition under which
 * stale authorization results must never be published.
 */
export class ControllableExecutor {
  private nextId = 0;
  private readonly pending = new Map<number, () => void>();

  /** Queue a task; the returned promise settles only when the task is completed. */
  submit<T>(task: () => T | Promise<T>): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, () => {
        Promise.resolve()
          .then(task)
          .then(resolve, reject);
      });
    });
  }

  /** Ids of tasks still waiting to be completed, in submission order. */
  get pendingIds(): number[] {
    return [...this.pending.keys()];
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Complete one specific pending task. Returns false if the id is unknown. */
  complete(id: number): boolean {
    const run = this.pending.get(id);
    if (run === undefined) return false;
    this.pending.delete(id);
    run();
    return true;
  }

  /**
   * Complete all currently pending tasks. Without an explicit order they run
   * in LIFO order (most recently submitted first) to stress out-of-order
   * completion by default; pass `order` to choose any permutation.
   */
  completeAll(order?: readonly number[]): void {
    const ids = order ?? [...this.pending.keys()].reverse();
    for (const id of ids) this.complete(id);
  }
}
