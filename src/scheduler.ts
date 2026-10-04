/**
 * Time source abstraction. The Coalescer only ever touches time through
 * this interface, so tests can swap in a fully deterministic virtual clock.
 */
export interface Scheduler {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Real wall-clock scheduler backed by Node.js built-in timers. */
export class SystemScheduler implements Scheduler {
  now(): number {
    return Date.now();
  }
  setTimeout(callback: () => void, delayMs: number): unknown {
    return setTimeout(callback, delayMs);
  }
  clearTimeout(handle: unknown): void {
    clearTimeout(handle);
  }
}

interface PendingTimer {
  id: number;
  at: number;
  callback: () => void;
}

/**
 * Controllable executor: a manual virtual clock. Timers never fire on their
 * own; they only run when `advance()` moves virtual time past their deadline.
 */
export class ManualScheduler implements Scheduler {
  private currentTime = 0;
  private nextId = 0;
  private timers: PendingTimer[] = [];

  now(): number {
    return this.currentTime;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = ++this.nextId;
    this.timers.push({ id, at: this.currentTime + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    const id = handle as number;
    this.timers = this.timers.filter((timer) => timer.id !== id);
  }

  /** Number of timers still waiting to fire. */
  get pending(): number {
    return this.timers.length;
  }

  /**
   * Advance virtual time by `ms`, firing every timer whose deadline falls
   * within the window (in deadline order, including timers scheduled by
   * timers). Returns the number of timers that fired.
   */
  advance(ms: number): number {
    const target = this.currentTime + ms;
    let fired = 0;
    for (;;) {
      let soonest: PendingTimer | undefined;
      for (const timer of this.timers) {
        if (timer.at <= target && (soonest === undefined || timer.at < soonest.at)) {
          soonest = timer;
        }
      }
      if (soonest === undefined) break;
      this.timers = this.timers.filter((timer) => timer.id !== soonest.id);
      this.currentTime = soonest.at;
      soonest.callback();
      fired++;
    }
    this.currentTime = target;
    return fired;
  }
}
