import { CrashError } from "./errors.js";
import type { WriteBoundary } from "./fileStorage.js";

/**
 * Crash injector for the interruptible storage adapter. Pass `hook` as
 * the `onBoundary` option of `FileStorageAdapter`; it lets `crashAfter`
 * write boundaries through and then raises `CrashError`, simulating a
 * hard process crash at that exact write boundary.
 *
 * After the crash the injector is spent. A "restart" is modeled by
 * constructing a brand-new `FileStorageAdapter` over the same directory
 * with a fresh injector (or none), forcing state to be recovered from
 * disk rather than from any in-memory cache.
 */
export class CrashInjector {
  /** Total number of write boundaries observed so far. */
  count = 0;
  /** Boundaries observed, in order (useful for assertions/debugging). */
  readonly seen: WriteBoundary[] = [];

  constructor(private readonly crashAfter: number) {}

  readonly hook = (boundary: WriteBoundary): void => {
    const index = this.count;
    this.count += 1;
    this.seen.push(boundary);
    if (index >= this.crashAfter) {
      throw new CrashError(`#${index} (${boundary})`);
    }
  };
}
