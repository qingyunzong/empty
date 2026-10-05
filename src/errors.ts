import type { Change } from "./types.js";

/**
 * Thrown when a page contains a record ID whose existing stored content
 * differs. The entire page is rejected: nothing from it is committed.
 */
export class PageConflictError extends Error {
  readonly conflicting: Change[];
  constructor(conflicting: Change[]) {
    const ids = conflicting.map((c) => c.id).join(", ");
    super(`page rejected: conflicting content for id(s): ${ids}`);
    this.name = "PageConflictError";
    this.conflicting = conflicting;
  }
}

/** Simulated process crash raised by the interruptible adapter. */
export class CrashError extends Error {
  constructor(boundary: string) {
    super(`simulated crash at write boundary: ${boundary}`);
    this.name = "CrashError";
  }
}
