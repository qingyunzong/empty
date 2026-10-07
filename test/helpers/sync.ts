/** One-shot gate: waiters block until `open()` is called. */
export class Gate {
  private openFlag = false;
  private waiters: Array<() => void> = [];

  wait(): Promise<void> {
    if (this.openFlag) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  open(): void {
    this.openFlag = true;
    for (const release of this.waiters.splice(0)) release();
  }
}

/** Single-generation barrier: `arrive()` blocks until `parties` arrivals. */
export class Barrier {
  private arrivals = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly parties: number) {}

  get arrived(): number {
    return this.arrivals;
  }

  arrive(): Promise<void> {
    this.arrivals++;
    if (this.arrivals >= this.parties) {
      for (const release of this.waiters.splice(0)) release();
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

/** Poll a condition, throwing on timeout. */
export async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
