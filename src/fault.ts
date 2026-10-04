/** Thrown when the injector simulates a process crash at a named point. */
export class CrashFault extends Error {
  constructor(readonly point: string) {
    super("simulated crash at persistence point: " + point);
    this.name = "CrashFault";
  }
}

/**
 * Deterministic fault injector. Checkpoints are named persistence points;
 * arming a point makes the next visit throw CrashFault (process death).
 * The fault is consumed by the crash, so the restarted run passes it.
 */
export class CrashInjector {
  readonly visited: string[] = [];
  private armed: string[];

  constructor(armed: readonly string[] = []) {
    this.armed = [...armed];
  }

  checkpoint(point: string): void {
    this.visited.push(point);
    const idx = this.armed.indexOf(point);
    if (idx !== -1) {
      this.armed.splice(idx, 1);
      throw new CrashFault(point);
    }
  }
}
