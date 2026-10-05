/** A single upsert change to a record. */
export interface Change {
  id: string;
  content: string;
}

/**
 * One page of a paginated change feed. `changes` and `nextCursor` are
 * committed atomically as a single batch: either both become durable or
 * neither does.
 */
export interface Page {
  changes: Change[];
  nextCursor: string;
}

/** Durable snapshot of the synced state. */
export interface Snapshot {
  records: Record<string, string>;
  cursor: string | null;
}

/** A batch = one page's changes plus the cursor that follows them. */
export interface Batch {
  changes: Change[];
  cursor: string;
}

/**
 * Storage adapter contract. Implementations must guarantee that
 * `commitBatch` is atomic with respect to crashes: after any restart,
 * `load()` returns either the state before the batch or the state after
 * the full batch (all changes + cursor), never anything in between.
 */
export interface StorageAdapter {
  load(): Snapshot;
  commitBatch(batch: Batch): void;
}
