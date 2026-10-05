import { PageConflictError } from "./errors.js";
import type { Page, Snapshot, StorageAdapter } from "./types.js";

/**
 * Offline sync engine. Applies paged changes to a storage adapter with
 * these guarantees:
 *
 * - Atomic batch: a page's changes and its next cursor are committed in
 *   one batch; a crash never persists one without the other.
 * - Idempotent replay: re-applying an already-applied page (same IDs,
 *   same content) succeeds and is a no-op.
 * - Whole-page rejection: if any incoming record ID already exists with
 *   different content, the entire page is rejected and nothing is
 *   committed.
 */
export class SyncEngine {
  private readonly storage: StorageAdapter;

  constructor(storage: StorageAdapter) {
    this.storage = storage;
  }

  applyPage(page: Page): void {
    const snapshot = this.storage.load();
    const seen = new Map<string, string>();
    const conflicting: { id: string; content: string }[] = [];

    for (const change of page.changes) {
      const priorInPage = seen.get(change.id);
      if (priorInPage !== undefined && priorInPage !== change.content) {
        conflicting.push(change);
        continue;
      }
      seen.set(change.id, change.content);
      const existing = snapshot.records[change.id];
      if (existing !== undefined && existing !== change.content) {
        conflicting.push(change);
      }
    }

    if (conflicting.length > 0) {
      throw new PageConflictError(conflicting);
    }

    this.storage.commitBatch({
      changes: page.changes,
      cursor: page.nextCursor,
    });
  }

  snapshot(): Snapshot {
    return this.storage.load();
  }
}
