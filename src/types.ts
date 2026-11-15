import type { BinaryLike } from "./binary.ts";
import type { CaptureInstanceSchema, CaptureSchemaLike } from "./schema.ts";
import type { UpdateMaskLike } from "./update-mask.ts";

/**
 * SQL Server CDC `__$operation` values.
 *
 * 1 = delete, 2 = insert, 3 = update before image, 4 = update after image.
 */
export const CdcOperation = {
  DELETE: 1,
  INSERT: 2,
  UPDATE_BEFORE: 3,
  UPDATE_AFTER: 4,
} as const;

export const Operation = CdcOperation;
export const ChangeOperation = CdcOperation;

export type CdcOperationValue = (typeof CdcOperation)[keyof typeof CdcOperation];
export type CdcOperationInput = CdcOperationValue | string;

/**
 * A row read from a CDC change table.  The `__$...` columns are the SQL Server
 * names; aliases without the prefix are also understood by the merger.
 */
export interface CdcChangeRow {
  "__$start_lsn"?: BinaryLike;
  "__$seqval"?: BinaryLike;
  "__$operation"?: CdcOperationInput;
  "__$update_mask"?: UpdateMaskLike | null;
  "__$command_id"?: number;
  start_lsn?: BinaryLike;
  startLsn?: BinaryLike;
  seqval?: BinaryLike;
  seqVal?: BinaryLike;
  operation?: CdcOperationInput;
  update_mask?: UpdateMaskLike | null;
  updateMask?: UpdateMaskLike | null;
  captureInstance?: string;
  capture_instance?: string;
  [column: string]: unknown;
}

export interface NormalizedChangeRow {
  raw: CdcChangeRow;
  captureInstance: string;
  startLsn: string;
  lsnKey: string;
  seqval: string;
  seqvalKey: string;
  key: string;
  operation: CdcOperationValue;
  updateMask?: Uint8Array;
}

export interface ChangeEventBase {
  kind: "update" | "insert" | "delete";
  type: "update" | "insert" | "delete";
  captureInstance: string;
  /** `0x`-prefixed LSN, preserving the source byte length. */
  lsn: string;
  /** Canonical LSN key (leading zero bytes removed). */
  lsnKey: string;
  seqval: string;
  seqvalKey: string;
  /** Opaque pairing/deduplication key: capture instance + LSN + seqval. */
  key: string;
  operation: CdcOperationValue;
  schema: CaptureInstanceSchema;
}

export interface MergedUpdate extends ChangeEventBase {
  kind: "update";
  type: "update";
  operation: typeof CdcOperation.UPDATE_AFTER;
  before: CdcChangeRow;
  after: CdcChangeRow;
  beforeImage: CdcChangeRow;
  afterImage: CdcChangeRow;
  beforeValues: Record<string, unknown>;
  afterValues: Record<string, unknown>;
  /** Convenience alias for `afterValues`. */
  values: Record<string, unknown>;
  /** Sparse after-image reconstructed by applying the mask to `before`. */
  mergedValues: Record<string, unknown>;
  changedColumns: string[];
  /** Alias for `changedColumns`. */
  updatedColumns: string[];
  /** Alias for `changedColumns`. */
  columns: string[];
  /** Mask bytes (before/after masks combined when they disagree). */
  updateMask: Uint8Array;
  /** `0x`-prefixed mask. */
  mask: string;
  /** Alias for `mask`. */
  maskHex: string;
  ordinals: number[];
}

export interface SingleRowChange extends ChangeEventBase {
  kind: "insert" | "delete";
  type: "insert" | "delete";
  operation: typeof CdcOperation.INSERT | typeof CdcOperation.DELETE;
  row: CdcChangeRow;
  values: Record<string, unknown>;
}

export type ChangeEvent = MergedUpdate | SingleRowChange;

export interface PendingChange {
  kind: "pending";
  captureInstance: string;
  key: string;
  lsn: string;
  lsnKey: string;
  seqval: string;
  seqvalKey: string;
  before?: CdcChangeRow;
  after?: CdcChangeRow;
  missing: Array<"before" | "after">;
  /** Monotonic insertion sequence, useful for deterministic diagnostics. */
  sequence: number;
}

export interface GapReport {
  kind: "gap";
  type: "gap";
  reason: "cleanup-watermark";
  captureInstance: string;
  key: string;
  lsn: string;
  lsnKey: string;
  seqval: string;
  seqvalKey: string;
  missing: Array<"before" | "after">;
  /** Cleanup watermark that made the missing half unrecoverable. */
  watermark: string;
  pending: PendingChange;
}

export type DuplicateReason = "published" | "gap" | "pending" | "conflict";

export interface DuplicateReport {
  kind: "duplicate";
  reason: DuplicateReason;
  captureInstance: string;
  key: string;
  lsn: string;
  seqval: string;
  side?: "before" | "after";
  row?: CdcChangeRow;
  message: string;
}

export interface IngestResult {
  /** Newly published changes (updates, inserts, and deletes). */
  changes: ChangeEvent[];
  updates: MergedUpdate[];
  /** Alias for `updates`. */
  merged: MergedUpdate[];
  /** Alias for `updates`. */
  paired: MergedUpdate[];
  inserts: SingleRowChange[];
  deletes: SingleRowChange[];
  /** Newly reported permanent gaps, normally produced by watermark advance. */
  gaps: GapReport[];
  duplicates: DuplicateReport[];
  /** Snapshot of all changes still waiting for their missing half. */
  pending: PendingChange[];
  /** Alias for `pending`. */
  pendingUpdates: PendingChange[];
  /** Alias for `pending`. */
  pendingRows: PendingChange[];
  /** True when at least one change was published. */
  didPublish: boolean;
  /** Alias for `changes`. */
  published: ChangeEvent[];
  /** Alias for `gaps`. */
  permanentGaps: GapReport[];
}

export interface PublishedEntry {
  key: string;
  captureInstance: string;
  lsn: string;
  lsnKey: string;
  seqval: string;
  seqvalKey: string;
  kind: ChangeEvent["kind"];
}

export interface GapStateEntry {
  key: string;
  captureInstance: string;
  lsn: string;
  lsnKey: string;
  seqval: string;
  seqvalKey: string;
  reason: "cleanup-watermark";
  missing: Array<"before" | "after">;
  watermark: string;
}

export interface MergerOptions {
  /** A single capture-instance schema, or a list of them. */
  schema?: CaptureSchemaLike;
  schemas?: readonly CaptureSchemaLike[] | Record<string, CaptureSchemaLike>;
  /** Capture instance used when a row does not name one. */
  captureInstance?: string;
  /** Restored state from `snapshot()` / `toJSON()`. */
  state?: MergerState | string;
  /** Initial cleanup watermark, applied after state restoration. */
  cleanupWatermark?: BinaryLike;
  /** Emit insert/delete rows as changes too. Defaults to true. */
  includeSingleRowChanges?: boolean;
  /** Optional observers, useful for a streaming service. */
  onChange?: (change: ChangeEvent) => void;
  onGap?: (gap: GapReport) => void;
  onDuplicate?: (duplicate: DuplicateReport) => void;
  /** Keep at most this many pending keys (0 means unlimited). */
  maxPending?: number;
  /**
   * Treat a pending LSN equal to the cleanup watermark as expired.  Defaults
   * to false because SQL cleanup removes rows strictly below the watermark.
   */
  watermarkInclusive?: boolean;
}

export interface SerializedRow {
  [column: string]: unknown;
}

export interface SerializedPending {
  key: string;
  captureInstance: string;
  lsn: string;
  lsnKey: string;
  seqval: string;
  seqvalKey: string;
  before?: SerializedRow;
  after?: SerializedRow;
  sequence: number;
}

export interface SerializedSchema {
  captureInstance: string;
  columns: Array<{
    ordinal: number;
    name: string;
    type?: string;
    nullable?: boolean;
  }>;
}

export interface MergerState {
  version: 1;
  captureInstance?: string;
  schemas?: SerializedSchema[];
  watermark?: string | null;
  instanceWatermarks?: Record<string, string>;
  published?: PublishedEntry[];
  gaps?: GapStateEntry[];
  pending?: SerializedPending[];
}
