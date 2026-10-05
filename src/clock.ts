export interface TimerHandle {
  readonly id: number;
  readonly time: number;
  cancel(): void;
  readonly cancelled: boolean;
}

interface ScheduledTask {
  id: number;
  time: number;
  seq: number;
  cb: () => void;
  cancelled: boolean;
}

async function flushMicrotasks(): Promise<void> {
  // Several ticks so chained promise continuations settle before the next
  // virtual event is processed.
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/**
 * Deterministic virtual clock. Events scheduled for the same tick fire in
 * insertion (FIFO) order, so same-tick races are decided by event order.
 * Microtasks are flushed after every event so promise reactions to an
 * event complete before the next event on the same tick is processed.
 */
export class VirtualClock {
  private _now = 0;
  private seq = 0;
  private nextId = 1;
  private queue: ScheduledTask[] = [];

  get now(): number {
    return this._now;
  }

  get pending(): number {
    return this.queue.filter((t) => !t.cancelled).length;
  }

  setTimeout(cb: () => void, delay: number): TimerHandle {
    if (delay < 0) throw new RangeError("delay must be >= 0");
    const task: ScheduledTask = {
      id: this.nextId++,
      time: this._now + delay,
      seq: this.seq++,
      cb,
      cancelled: false,
    };
    this.queue.push(task);
    const handle: TimerHandle = {
      id: task.id,
      get time() {
        return task.time;
      },
      get cancelled() {
        return task.cancelled;
      },
      cancel() {
        task.cancelled = true;
      },
    };
    return handle;
  }

  /** Run every scheduled event until the queue is empty. */
  async runUntilIdle(): Promise<void> {
    for (;;) {
      const task = this.nextTask();
      if (!task) {
        await flushMicrotasks();
        return;
      }
      this._now = task.time;
      task.cb();
      await flushMicrotasks();
    }
  }

  /** Advance the clock by `ms`, firing events due within the window. */
  async advance(ms: number): Promise<void> {
    if (ms < 0) throw new RangeError("ms must be >= 0");
    const limit = this._now + ms;
    for (;;) {
      const task = this.nextTask();
      if (!task || task.time > limit) {
        this._now = limit;
        await flushMicrotasks();
        return;
      }
      this._now = task.time;
      task.cb();
      await flushMicrotasks();
    }
  }

  private nextTask(): ScheduledTask | undefined {
    let best: ScheduledTask | undefined;
    for (const t of this.queue) {
      if (t.cancelled) continue;
      if (
        !best ||
        t.time < best.time ||
        (t.time === best.time && t.seq < best.seq)
      ) {
        best = t;
      }
    }
    if (!best) {
      this.queue = [];
      return undefined;
    }
    this.queue.splice(this.queue.indexOf(best), 1);
    return best;
  }
}
