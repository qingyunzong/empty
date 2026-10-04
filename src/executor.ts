type Resolve = (value: unknown) => void;
type Reject = (reason?: unknown) => void;

interface PendingTask {
  run: () => unknown;
  resolve: Resolve;
  reject: Reject;
}

/**
 * Controllable executor: submitted tasks are queued instead of running
 * immediately. Tests drive completion explicitly and in any order, which
 * simulates out-of-order completion of asynchronous authorization queries.
 */
export class ControlledExecutor {
  private nextTicket = 0;
  private readonly pending = new Map<number, PendingTask>();

  submit<T>(run: () => T): Promise<T> {
    const ticket = ++this.nextTicket;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(ticket, { run, resolve: resolve as Resolve, reject });
    });
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  tickets(): number[] {
    return [...this.pending.keys()];
  }

  complete(ticket: number): boolean {
    const task = this.pending.get(ticket);
    if (task === undefined) {
      return false;
    }
    this.pending.delete(ticket);
    try {
      task.resolve(task.run());
    } catch (error) {
      task.reject(error);
    }
    return true;
  }

  completeAll(order: number[] = this.tickets()): void {
    for (const ticket of order) {
      this.complete(ticket);
    }
  }
}
