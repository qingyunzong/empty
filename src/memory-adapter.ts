import type { FileAdapter } from "./types";

/** Thrown when a simulated power cut interrupts the adapter. */
export class PowerCutError extends Error {
  constructor() {
    super("simulated power cut");
    this.name = "PowerCutError";
  }
}

/**
 * In-memory FileAdapter for tests and desktop shells without a real disk.
 *
 * Fault injection:
 *  - crashAfterWrites(n): after n more successful writes, the next write
 *    raises PowerCutError and every subsequent operation throws until
 *    reboot() is called. Persisted files survive, uncommitted writes do not.
 */
export class MemoryFileAdapter implements FileAdapter {
  private files = new Map<string, string>();
  private writesUntilCrash: number | null = null;
  private crashed = false;

  /** Total successful write() calls, for assertions. */
  writeCount = 0;

  read(path: string): string | null {
    this.ensureAlive();
    return this.files.get(path) ?? null;
  }

  exists(path: string): boolean {
    this.ensureAlive();
    return this.files.has(path);
  }

  write(path: string, data: string): void {
    this.ensureAlive();
    if (this.writesUntilCrash !== null) {
      if (this.writesUntilCrash === 0) {
        this.crashed = true;
        throw new PowerCutError();
      }
      this.writesUntilCrash -= 1;
    }
    this.files.set(path, data);
    this.writeCount += 1;
  }

  delete(path: string): void {
    this.ensureAlive();
    this.files.delete(path);
  }

  /** Arm the power cut: the write after `count` more writes kills the adapter. */
  crashAfterWrites(count: number): void {
    this.writesUntilCrash = count;
  }

  /** Simulate a restart: persisted files are still there. */
  reboot(): void {
    this.crashed = false;
    this.writesUntilCrash = null;
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.files);
  }

  private ensureAlive(): void {
    if (this.crashed) throw new PowerCutError();
  }
}
