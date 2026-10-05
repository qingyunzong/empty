import type { Device } from "./device.js";

/** Simulated power loss. The device stays dead afterwards; recover by
 * constructing a fresh device/adapter over the same directory (restart). */
export class CrashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrashError";
  }
}

/**
 * Device wrapper that crashes at a chosen write boundary. Write boundaries
 * are counted across writeTmp/fsyncFile/rename/fsyncDir calls. When `torn`
 * is set, a crash at the writeTmp boundary first leaves a partially written
 * tmp file behind, mimicking a torn write that recovery must ignore.
 */
export class InterruptibleDevice implements Device {
  private ops = 0;
  private dead = false;

  constructor(
    private readonly inner: Device,
    private readonly crashAt: number | null,
    private readonly torn: boolean = false,
  ) {}

  private boundary(run: () => void, preCrash?: () => void): void {
    if (this.dead) throw new CrashError("device offline (simulated power loss)");
    this.ops += 1;
    if (this.crashAt !== null && this.ops === this.crashAt) {
      preCrash?.();
      this.dead = true;
      throw new CrashError(`simulated crash at write boundary #${this.ops}`);
    }
    run();
  }

  writeTmp(path: string, data: string): void {
    this.boundary(
      () => this.inner.writeTmp(path, data),
      this.torn
        ? () => this.inner.writeTmp(path, data.slice(0, Math.floor(data.length / 2)))
        : undefined,
    );
  }

  fsyncFile(path: string): void {
    this.boundary(() => this.inner.fsyncFile(path));
  }

  rename(tmpPath: string, finalPath: string): void {
    this.boundary(() => this.inner.rename(tmpPath, finalPath));
  }

  fsyncDir(path: string): void {
    this.boundary(() => this.inner.fsyncDir(path));
  }

  readFile(path: string): string | null {
    if (this.dead) throw new CrashError("device offline (simulated power loss)");
    return this.inner.readFile(path);
  }
}
