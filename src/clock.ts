export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface VirtualTimer {
  at: number;
  callback: () => void;
  order: number;
}

/**
 * A deterministic clock for tests and simulations. Timers scheduled for the
 * same instant run in insertion order.
 */
export class VirtualClock implements Clock {
  #time: number;
  #nextTimerId = 1;
  #nextOrder = 1;
  #timers = new Map<number, VirtualTimer>();

  constructor(startTime = 0) {
    if (!Number.isFinite(startTime)) {
      throw new RangeError("VirtualClock startTime must be finite");
    }
    this.#time = startTime;
  }

  now(): number {
    return this.#time;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    if (typeof callback !== "function") {
      throw new TypeError("setTimeout callback must be a function");
    }
    if (!Number.isFinite(delayMs)) {
      throw new RangeError("setTimeout delay must be finite");
    }

    const id = this.#nextTimerId++;
    this.#timers.set(id, {
      at: this.#time + Math.max(0, delayMs),
      callback,
      order: this.#nextOrder++,
    });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") {
      this.#timers.delete(handle);
    }
  }

  /**
   * Advance to an absolute time, running every due timer on the way.
   * Returns the number of callbacks that ran.
   */
  advanceTo(targetTime: number): number {
    if (!Number.isFinite(targetTime)) {
      throw new RangeError("target time must be finite");
    }
    if (targetTime < this.#time) {
      throw new RangeError("VirtualClock cannot move backwards");
    }

    let callbacksRun = 0;
    while (true) {
      const next = this.#nextDueTimer(targetTime);
      if (next === undefined) {
        break;
      }
      this.#time = next.at;
      this.#timers.delete(next.id);
      next.timer.callback();
      callbacksRun++;
    }
    this.#time = targetTime;
    return callbacksRun;
  }

  advanceBy(deltaMs: number): number {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) {
      throw new RangeError("VirtualClock delta must be a non-negative number");
    }
    return this.advanceTo(this.#time + deltaMs);
  }

  tick(deltaMs: number): number {
    return this.advanceBy(deltaMs);
  }

  get pendingTimerCount(): number {
    return this.#timers.size;
  }

  get nextTimerAt(): number | undefined {
    let earliest: number | undefined;
    for (const timer of this.#timers.values()) {
      if (earliest === undefined || timer.at < earliest) {
        earliest = timer.at;
      }
    }
    return earliest;
  }

  #nextDueTimer(limit: number): { id: number; at: number; timer: VirtualTimer } | undefined {
    let found:
      | { id: number; at: number; timer: VirtualTimer }
      | undefined;

    for (const [id, timer] of this.#timers) {
      if (timer.at > limit) {
        continue;
      }
      if (
        found === undefined ||
        timer.at < found.at ||
        (timer.at === found.at && timer.order < found.timer.order)
      ) {
        found = { id, at: timer.at, timer };
      }
    }
    return found;
  }
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    return globalThis.setTimeout(callback, Math.max(0, delayMs));
  }

  clearTimeout(handle: unknown): void {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}

export const systemClock = new SystemClock();
