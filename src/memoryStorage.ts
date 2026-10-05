import type { Batch, Snapshot, StorageAdapter } from "./types.js";

/** Volatile adapter, used as the sequential-application reference. */
export class MemoryStorageAdapter implements StorageAdapter {
  private snapshot: Snapshot = { records: {}, cursor: null };

  load(): Snapshot {
    return { records: { ...this.snapshot.records }, cursor: this.snapshot.cursor };
  }

  commitBatch(batch: Batch): void {
    const records = { ...this.snapshot.records };
    for (const change of batch.changes) {
      records[change.id] = change.content;
    }
    this.snapshot = { records, cursor: batch.cursor };
  }
}
