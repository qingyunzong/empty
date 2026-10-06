// Deterministic manual scheduler. Implementations under test never touch
// timers directly; they defer continuations here, and the harness decides
// when they run. Promise settlement is therefore scheduler-controlled:
// a promise only settles once the pumped continuation resolves it.
export class Scheduler {
  private queue: Array<() => void> = [];

  defer(fn: () => void): void {
    this.queue.push(fn);
  }

  get pending(): number {
    return this.queue.length;
  }

  // Run up to `steps` queued continuations in FIFO order. Returns how many ran.
  pump(steps: number = Number.POSITIVE_INFINITY): number {
    let ran = 0;
    while (this.queue.length > 0 && ran < steps) {
      const fn = this.queue.shift();
      if (fn === undefined) break;
      fn();
      ran += 1;
    }
    return ran;
  }
}

// Flush the microtask queue so promise reactions scheduled by pumped
// continuations are observed before the harness records state.
export function flushMicrotasks(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}
