import { toTime, type TimeInput } from "./track.js";

/**
 * A manually driven clock. It never reads the wall clock: time only
 * advances through tick(), so pause/resume is exact and deterministic.
 */
export class Clock {
  private position: bigint;
  private running = true;

  constructor(start: TimeInput = 0) {
    this.position = toTime(start);
  }

  get time(): bigint {
    return this.position;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Advances by delta integer units when running; a no-op while paused. */
  tick(delta: TimeInput = 1): bigint {
    if (this.running) this.position += toTime(delta);
    return this.position;
  }

  pause(): void {
    this.running = false;
  }

  /** Resumes exactly where the clock paused; no wall-clock catch-up. */
  resume(): void {
    this.running = true;
  }

  seek(t: TimeInput): void {
    this.position = toTime(t);
  }
}
