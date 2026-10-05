import type { StorageAdapter } from "./adapter.js";
import type { Page, Snapshot } from "./types.js";

/** Thrown when a page is rejected; nothing from the page is persisted. */
export class ConflictError extends Error {
  constructor(readonly id: string) {
    super(`conflicting content for id "${id}"; entire page rejected`);
    this.name = "ConflictError";
  }
}

export interface ApplyResult {
  /** false when the page was an idempotent replay of an already-applied page. */
  applied: boolean;
  cursor: string | null;
}

export class SyncEngine {
  constructor(private readonly adapter: StorageAdapter) {}

  snapshot(): Snapshot {
    return this.adapter.load();
  }

  /**
   * Applies one page of changes plus its next cursor as a single atomic
   * batch.
   *
   * - Replay: a page whose nextCursor was already applied is a no-op, no
   *   matter how far the stored cursor has advanced since. This makes
   *   re-sending any already-applied page after a crash safe.
   * - Conflict: any change whose id already exists with different content
   *   (in storage or earlier in the same page) rejects the entire page
   *   before anything is written.
   */
  applyPage(page: Page): ApplyResult {
    const state = this.adapter.load();

    if (state.appliedCursors.includes(page.nextCursor)) {
      return { applied: false, cursor: state.cursor };
    }

    const incoming = new Map<string, string>();
    for (const change of page.changes) {
      const existing = incoming.get(change.id) ?? state.records[change.id];
      if (existing !== undefined && existing !== change.content) {
        throw new ConflictError(change.id);
      }
      incoming.set(change.id, change.content);
    }

    const records = new Map(Object.entries(state.records));
    for (const [id, content] of incoming) {
      records.set(id, content);
    }
    this.adapter.commitBatch({
      records: Object.fromEntries(records),
      cursor: page.nextCursor,
      appliedCursors: [...state.appliedCursors, page.nextCursor],
    });
    return { applied: true, cursor: page.nextCursor };
  }
}
