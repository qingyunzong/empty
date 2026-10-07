/**
 * Logical animation clock. Time advances only through explicit tick() calls
 * while running; pause()/resume() never consult the wall clock, so a paused
 * span contributes exactly zero elapsed time.
 */
export class Clock {
  private elapsed: bigint = 0n;
  private running = true;

  get time(): bigint {
    return this.elapsed;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Advance by dt integer ticks when running; a no-op while paused. */
  tick(dt: bigint | number): bigint {
    const step = BigInt(dt);
    if (step < 0n) {
      throw new RangeError("tick delta must not be negative");
    }
    if (this.running) {
      this.elapsed += step;
    }
    return this.elapsed;
  }

  pause(): void {
    this.running = false;
  }

  resume(): void {
    this.running = true;
  }
}
