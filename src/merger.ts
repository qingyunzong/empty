import {
  canonicalLsn,
  compareLsn,
  decodeBinaryFromJson,
  encodeBinaryForJson,
  normalizeLsn,
  toMaskBytes,
  type BinaryLike,
} from "./binary.ts";
import {
  DEFAULT_CAPTURE_INSTANCE,
  normalizeSchema,
  schemaColumnNames,
  type CaptureInstanceSchema,
  type CaptureSchemaLike,
} from "./schema.ts";
import {
  applyUpdateMask,
  decodeUpdateMask,
  explainUpdateMask,
  inferChangedColumns,
  isColumnUpdated,
  isMaskBitSet,
  maskHasAnyBit,
  projectCaptureRow,
  type UpdateMaskArgument,
} from "./update-mask.ts";
import {
  CdcOperation,
  type CdcChangeRow,
  type CdcOperationInput,
  type CdcOperationValue,
  type ChangeEvent,
  type DuplicateReport,
  type GapReport,
  type GapStateEntry,
  type IngestResult,
  type MergerOptions,
  type MergerState,
  type MergedUpdate,
  type NormalizedChangeRow,
  type PendingChange,
  type PublishedEntry,
  type SerializedPending,
  type SerializedSchema,
  type SingleRowChange,
} from "./types.ts";

const OPERATION_NAMES: Record<string, CdcOperationValue> = {
  "1": CdcOperation.DELETE,
  "2": CdcOperation.INSERT,
  "3": CdcOperation.UPDATE_BEFORE,
  "4": CdcOperation.UPDATE_AFTER,
  delete: CdcOperation.DELETE,
  "delete-image": CdcOperation.DELETE,
  insert: CdcOperation.INSERT,
  "insert-image": CdcOperation.INSERT,
  update: CdcOperation.UPDATE_AFTER,
  "update-before": CdcOperation.UPDATE_BEFORE,
  update_before: CdcOperation.UPDATE_BEFORE,
  before: CdcOperation.UPDATE_BEFORE,
  "before-image": CdcOperation.UPDATE_BEFORE,
  "update-after": CdcOperation.UPDATE_AFTER,
  update_after: CdcOperation.UPDATE_AFTER,
  after: CdcOperation.UPDATE_AFTER,
  "after-image": CdcOperation.UPDATE_AFTER,
};

export interface IngestOptions {
  captureInstance?: string;
  schema?: CaptureSchemaLike;
  includeSingleRowChanges?: boolean;
}

export interface MergeRowsOptions extends Omit<MergerOptions, "schema" | "schemas"> {
  /** Cleanup watermark applied after all rows have been ingested. */
  watermark?: BinaryLike;
  /** Alias for `watermark`. */
  cleanupWatermark?: BinaryLike;
  /** Per-capture-instance cleanup watermarks applied after ingest. */
  instanceWatermarks?: Record<string, BinaryLike>;
}

/**
 * Opaque key used to pair before/after images.  Capture instance is included
 * because two instances may legitimately observe the same LSN in one database.
 */
export function makeChangeKey(
  captureInstance: string,
  lsn: BinaryLike,
  seqval: BinaryLike,
): string {
  return `${captureInstance}\u0000${canonicalLsn(lsn)}\u0000${canonicalLsn(seqval)}`;
}

export const changeKey = makeChangeKey;
export const pairKey = makeChangeKey;

interface PendingInternal {
  key: string;
  captureInstance: string;
  lsn: string;
  lsnKey: string;
  seqval: string;
  seqvalKey: string;
  before?: CdcChangeRow;
  after?: CdcChangeRow;
  sequence: number;
}

interface MergerInternals {
  schemas: Map<string, CaptureInstanceSchema>;
  fallbackSchema?: CaptureInstanceSchema;
  defaultCaptureInstance?: string;
  published: Map<string, PublishedEntry>;
  gaps: Map<string, GapStateEntry>;
  pending: Map<string, PendingInternal>;
  globalWatermark?: string;
  instanceWatermarks: Map<string, string>;
  sequence: number;
  includeSingleRowChanges: boolean;
  watermarkInclusive: boolean;
  maxPending: number;
  onChange?: (change: ChangeEvent) => void;
  onGap?: (gap: GapReport) => void;
  onDuplicate?: (duplicate: DuplicateReport) => void;
}

function firstPresent(
  row: Record<string, unknown>,
  names: readonly string[],
): unknown {
  for (const name of names) {
    if (row[name] !== undefined) {
      return row[name];
    }
  }
  return undefined;
}

function maskValueIsEmpty(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (value instanceof Uint8Array) {
    return value.length === 0;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (typeof value === "string") {
    return value.replace(/^0x/i, "").replace(/[\s:_-]/g, "").length === 0;
  }
  return false;
}

function normalizeOperation(value: unknown): CdcOperationValue {
  if (typeof value === "number") {
    if (value === 1 || value === 2 || value === 3 || value === 4) {
      return value;
    }
    throw new RangeError(`Unknown CDC operation: ${String(value)}`);
  }
  if (typeof value === "bigint") {
    if (value === 1n || value === 2n || value === 3n || value === 4n) {
      return Number(value) as CdcOperationValue;
    }
    throw new RangeError(`Unknown CDC operation: ${String(value)}`);
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase().replace(/\s+/g, "-");
    const operation = OPERATION_NAMES[normalized];
    if (operation !== undefined) {
      return operation;
    }
    if (/^[1-4]$/.test(normalized)) {
      return Number(normalized) as CdcOperationValue;
    }
  }
  throw new RangeError(`Unknown CDC operation: ${String(value)}`);
}

function operationSide(operation: CdcOperationValue): "before" | "after" | undefined {
  if (operation === CdcOperation.UPDATE_BEFORE) {
    return "before";
  }
  if (operation === CdcOperation.UPDATE_AFTER) {
    return "after";
  }
  return undefined;
}

function rowsEqual(left: CdcChangeRow, right: CdcChangeRow): boolean {
  return (
    JSON.stringify(encodeBinaryForJson(left)) === JSON.stringify(encodeBinaryForJson(right))
  );
}

function emptyResult(): IngestResult {
  const result: IngestResult = {
    changes: [],
    updates: [],
    merged: [],
    paired: [],
    inserts: [],
    deletes: [],
    gaps: [],
    duplicates: [],
    pending: [],
    pendingUpdates: [],
    pendingRows: [],
    didPublish: false,
    published: [],
    permanentGaps: [],
  };
  return result;
}

function finalizeResult(result: IngestResult): IngestResult {
  result.merged = result.updates;
  result.paired = result.updates;
  result.pendingUpdates = result.pending;
  result.pendingRows = result.pending;
  result.published = result.changes;
  result.permanentGaps = result.gaps;
  return result;
}

function compareEvents(left: ChangeEvent, right: ChangeEvent): number {
  const lsn = compareLsn(left.lsnKey, right.lsnKey);
  if (lsn !== 0) {
    return lsn;
  }
  const seqval = compareLsn(left.seqvalKey, right.seqvalKey);
  if (seqval !== 0) {
    return seqval;
  }
  return left.kind.localeCompare(right.kind);
}

function compareGaps(left: GapReport, right: GapReport): number {
  const lsn = compareLsn(left.lsnKey, right.lsnKey);
  if (lsn !== 0) {
    return lsn;
  }
  return compareLsn(left.seqvalKey, right.seqvalKey);
}

/**
 * Pairs SQL Server CDC update before/after rows and interprets
 * `__$update_mask` against the capture-instance schema.
 *
 * The merger is deliberately stateful:
 * - an update half is held in `pending` until its counterpart arrives;
 * - `advanceWatermark()` turns stale pending halves into permanent gaps;
 * - `snapshot()` / `restore()` make deduplication survive a service restart.
 */
export class CdcChangeMerger {
  private readonly internals: MergerInternals;

  constructor(options: MergerOptions | CaptureSchemaLike = {}) {
    const config: MergerOptions =
      Array.isArray(options) ||
      (typeof options === "object" &&
        options !== null &&
        "columns" in options &&
        !("schema" in options) &&
        !("schemas" in options) &&
        !("state" in options))
        ? { schema: options as CaptureSchemaLike }
        : (options as MergerOptions);
    const schemas = new Map<string, CaptureInstanceSchema>();
    let fallbackSchema: CaptureInstanceSchema | undefined;

    const register = (schemaLike: CaptureSchemaLike): CaptureInstanceSchema => {
      const schema = normalizeSchema(schemaLike, config.captureInstance);
      schemas.set(schema.captureInstance, schema);
      if (
        fallbackSchema === undefined ||
        fallbackSchema.captureInstance === schema.captureInstance
      ) {
        fallbackSchema = schema;
      }
      return schema;
    };

    if (config.schema !== undefined) {
      register(config.schema);
    }
    if (Array.isArray(config.schemas)) {
      for (const schema of config.schemas) {
        register(schema);
      }
    } else if (config.schemas !== undefined) {
      for (const [name, schema] of Object.entries(config.schemas)) {
        const registered = normalizeSchema(schema, name);
        schemas.set(name, registered);
        if (fallbackSchema === undefined) {
          fallbackSchema = registered;
        }
      }
    }

    this.internals = {
      schemas,
      fallbackSchema,
      defaultCaptureInstance: config.captureInstance,
      published: new Map(),
      gaps: new Map(),
      pending: new Map(),
      instanceWatermarks: new Map(),
      sequence: 0,
      includeSingleRowChanges: config.includeSingleRowChanges ?? true,
      watermarkInclusive: config.watermarkInclusive ?? false,
      maxPending: config.maxPending ?? 0,
      onChange: config.onChange,
      onGap: config.onGap,
      onDuplicate: config.onDuplicate,
    };

    if (config.state !== undefined) {
      this.restore(
        typeof config.state === "string"
          ? (JSON.parse(config.state) as MergerState)
          : config.state,
      );
    }
    if (config.cleanupWatermark !== undefined) {
      this.advanceWatermark(config.cleanupWatermark);
    }
  }

  /** Decode a mask against a registered schema or an explicit one. */
  decode(mask: UpdateMaskArgument, schema?: CaptureSchemaLike): string[] {
    const resolved = schema ?? this.internals.fallbackSchema;
    if (resolved === undefined) {
      throw new Error("No capture-instance schema registered for mask decoding");
    }
    return decodeUpdateMask(mask, resolved);
  }

  decodeMask(
    mask: UpdateMaskArgument,
    schema?: CaptureSchemaLike,
  ): string[] {
    return this.decode(mask, schema);
  }

  parse(mask: UpdateMaskArgument, schema?: CaptureSchemaLike): string[] {
    return this.decode(mask, schema);
  }

  interpret(mask: UpdateMaskArgument, schema?: CaptureSchemaLike): string[] {
    return this.decode(mask, schema);
  }

  explainMask(
    mask: UpdateMaskArgument,
    schema?: CaptureSchemaLike,
  ): ReturnType<typeof explainUpdateMask> {
    const resolved = schema ?? this.internals.fallbackSchema;
    if (resolved === undefined) {
      throw new Error("No capture-instance schema registered for mask decoding");
    }
    return explainUpdateMask(mask, resolved);
  }

  explain(
    mask: UpdateMaskArgument,
    schema?: CaptureSchemaLike,
  ): ReturnType<typeof explainUpdateMask> {
    return this.explainMask(mask, schema);
  }

  isBitSet(mask: Parameters<typeof isMaskBitSet>[0], bit: number): boolean {
    return isMaskBitSet(mask, bit);
  }

  isColumnUpdated(
    mask: Parameters<typeof isColumnUpdated>[0],
    ordinal: number,
  ): boolean {
    return isColumnUpdated(mask, ordinal);
  }

  registerSchema(schemaLike: CaptureSchemaLike, captureInstance?: string): CaptureInstanceSchema {
    const schema = normalizeSchema(schemaLike, captureInstance);
    this.internals.schemas.set(schema.captureInstance, schema);
    if (
      this.internals.fallbackSchema === undefined ||
      this.internals.fallbackSchema.captureInstance === schema.captureInstance
    ) {
      this.internals.fallbackSchema = schema;
    }
    return schema;
  }

  getSchema(captureInstance: string): CaptureInstanceSchema | undefined {
    return this.internals.schemas.get(captureInstance);
  }

  listSchemas(): CaptureInstanceSchema[] {
    return [...this.internals.schemas.values()];
  }

  get pendingCount(): number {
    return this.internals.pending.size;
  }

  get publishedCount(): number {
    return this.internals.published.size;
  }

  get gapCount(): number {
    return this.internals.gaps.size;
  }

  get watermark(): string | undefined {
    return this.internals.globalWatermark;
  }

  get cleanupWatermark(): string | undefined {
    return this.internals.globalWatermark;
  }

  ingest(row: CdcChangeRow, options: IngestOptions = {}): IngestResult {
    const result = emptyResult();
    this.ingestInto(row, options, result);
    result.pending = this.listPending();
    return finalizeResult(result);
  }

  /** Streaming aliases. */
  push(row: CdcChangeRow, options: IngestOptions = {}): IngestResult {
    return this.ingest(row, options);
  }

  process(row: CdcChangeRow, options: IngestOptions = {}): IngestResult {
    return this.ingest(row, options);
  }

  processRow(row: CdcChangeRow, options: IngestOptions = {}): IngestResult {
    return this.ingest(row, options);
  }

  addRow(row: CdcChangeRow, options: IngestOptions = {}): IngestResult {
    return this.ingest(row, options);
  }

  merge(row: CdcChangeRow, options: IngestOptions = {}): IngestResult {
    return this.ingest(row, options);
  }

  consume(row: CdcChangeRow, options: IngestOptions = {}): IngestResult {
    return this.ingest(row, options);
  }

  /**
   * Ingest a batch.  Published changes are sorted by LSN and seqval so the
   * result does not depend on input order.
   */
  ingestMany(rows: readonly CdcChangeRow[], options: IngestOptions = {}): IngestResult {
    const result = emptyResult();
    for (const row of rows) {
      this.ingestInto(row, options, result);
    }
    result.changes.sort(compareEvents);
    result.updates.sort(compareEvents);
    result.inserts.sort(compareEvents);
    result.deletes.sort(compareEvents);
    result.gaps.sort(compareGaps);
    result.pending = this.listPending();
    return finalizeResult(result);
  }

  pushMany(rows: readonly CdcChangeRow[], options: IngestOptions = {}): IngestResult {
    return this.ingestMany(rows, options);
  }

  processRows(rows: readonly CdcChangeRow[], options: IngestOptions = {}): IngestResult {
    return this.ingestMany(rows, options);
  }

  private resolveSchema(
    instance: string,
    explicitSchema?: CaptureSchemaLike,
  ): CaptureInstanceSchema {
    if (explicitSchema !== undefined) {
      const schema = normalizeSchema(explicitSchema, instance);
      this.internals.schemas.set(schema.captureInstance, schema);
      if (this.internals.fallbackSchema === undefined) {
        this.internals.fallbackSchema = schema;
      }
      return schema;
    }
    const registered = this.internals.schemas.get(instance);
    if (registered !== undefined) {
      return registered;
    }
    if (this.internals.fallbackSchema !== undefined) {
      if (this.internals.fallbackSchema.captureInstance === instance) {
        return this.internals.fallbackSchema;
      }
      // A single schema is commonly used while rows still carry their real
      // capture-instance name.  Rebind the schema to that name so keys from
      // different instances remain distinct.
      const rebound: CaptureInstanceSchema = {
        ...this.internals.fallbackSchema,
        captureInstance: instance,
      };
      this.internals.schemas.set(instance, rebound);
      return rebound;
    }
    throw new Error(
      `No capture-instance schema registered for "${instance}". ` +
        "Pass a schema to the constructor or to ingest().",
    );
  }

  private normalizeRow(
    row: CdcChangeRow,
    options: IngestOptions,
  ): NormalizedChangeRow & { schema: CaptureInstanceSchema } {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new TypeError("CDC row must be an object");
    }

    const rawLsn = firstPresent(row, ["__$start_lsn", "start_lsn", "startLsn"]);
    const rawSeqval = firstPresent(row, ["__$seqval", "__$seqVal", "seqval", "seqVal"]);
    const rawOperation = firstPresent(row, ["__$operation", "operation"]);
    if (rawLsn === undefined || rawLsn === null) {
      throw new TypeError("CDC row is missing __$start_lsn");
    }
    if (rawSeqval === undefined || rawSeqval === null) {
      throw new TypeError("CDC row is missing __$seqval");
    }
    if (rawOperation === undefined || rawOperation === null) {
      throw new TypeError("CDC row is missing __$operation");
    }

    const operation = normalizeOperation(rawOperation);
    const instance =
      options.captureInstance ??
      (firstPresent(row, ["captureInstance", "capture_instance"]) as string | undefined) ??
      this.internals.defaultCaptureInstance ??
      this.internals.fallbackSchema?.captureInstance ??
      DEFAULT_CAPTURE_INSTANCE;
    const schema = this.resolveSchema(instance, options.schema);
    const startLsn = normalizeLsn(rawLsn as Parameters<typeof normalizeLsn>[0]);
    const lsnKey = canonicalLsn(rawLsn as Parameters<typeof canonicalLsn>[0]);
    const seqval = normalizeLsn(rawSeqval as Parameters<typeof normalizeLsn>[0]);
    const seqvalKey = canonicalLsn(rawSeqval as Parameters<typeof canonicalLsn>[0]);
    const rawMask = firstPresent(row, ["__$update_mask", "update_mask", "updateMask"]);
    const updateMask =
      maskValueIsEmpty(rawMask)
        ? undefined
        : toMaskBytes(rawMask as Parameters<typeof toMaskBytes>[0]);

    return {
      raw: row,
      captureInstance: schema.captureInstance,
      startLsn,
      lsnKey,
      seqval,
      seqvalKey,
      key: makeChangeKey(schema.captureInstance, startLsn, seqval),
      operation,
      updateMask,
      schema,
    };
  }

  private ingestInto(row: CdcChangeRow, options: IngestOptions, result: IngestResult): void {
    const normalized = this.normalizeRow(row, options);
    const { key, captureInstance, startLsn, lsnKey, seqval, seqvalKey, operation, schema } =
      normalized;

    const published = this.internals.published.get(key);
    if (published !== undefined) {
      this.recordDuplicate(result, {
        kind: "duplicate",
        reason: "published",
        captureInstance,
        key,
        lsn: startLsn,
        seqval,
        row,
        message: `Change ${key} was already published`,
      });
      return;
    }
    if (this.internals.gaps.has(key)) {
      this.recordDuplicate(result, {
        kind: "duplicate",
        reason: "gap",
        captureInstance,
        key,
        lsn: startLsn,
        seqval,
        row,
        message: `Change ${key} was already reported as a permanent gap`,
      });
      return;
    }

    const side = operationSide(operation);
    if (side === undefined) {
      this.publishSingleRow(normalized, options, result);
      return;
    }

    if (this.isExpired(lsnKey, captureInstance)) {
      this.internals.pending.delete(key);
      const expiredPending: PendingInternal = {
        key,
        captureInstance,
        lsn: startLsn,
        lsnKey,
        seqval,
        seqvalKey,
        sequence: this.internals.sequence++,
      };
      expiredPending[side] = row;
      this.reportGap(expiredPending, result);
      return;
    }

    const pending = this.internals.pending.get(key);
    if (pending === undefined) {
      this.ensurePendingCapacity();
      const created: PendingInternal = {
        key,
        captureInstance,
        lsn: startLsn,
        lsnKey,
        seqval,
        seqvalKey,
        sequence: this.internals.sequence++,
      };
      created[side] = row;
      this.internals.pending.set(key, created);
      return;
    }

    const existing = pending[side];
    if (existing !== undefined) {
      this.recordDuplicate(result, {
        kind: "duplicate",
        reason: rowsEqual(existing, row) ? "pending" : "conflict",
        captureInstance,
        key,
        lsn: startLsn,
        seqval,
        side,
        row,
        message: rowsEqual(existing, row)
          ? `Duplicate ${side} image for ${key} is already pending`
          : `Conflicting ${side} image for ${key}; keeping the first image`,
      });
      return;
    }

    pending[side] = row;
    if (pending.before !== undefined && pending.after !== undefined) {
      this.publishUpdate(pending, schema, result);
    }
  }

  private ensurePendingCapacity(): void {
    const limit = this.internals.maxPending;
    if (limit > 0 && this.internals.pending.size >= limit) {
      throw new RangeError(`Pending CDC change limit (${limit}) exceeded`);
    }
  }

  private effectiveWatermark(captureInstance: string): string | undefined {
    return this.maxWatermark(
      this.internals.instanceWatermarks.get(captureInstance),
      this.internals.globalWatermark,
    );
  }

  private isExpired(lsnKey: string, captureInstance: string): boolean {
    const threshold = this.effectiveWatermark(captureInstance);
    if (threshold === undefined) {
      return false;
    }
    const comparison = compareLsn(lsnKey, threshold);
    return this.internals.watermarkInclusive ? comparison <= 0 : comparison < 0;
  }

  private reportGap(pending: PendingInternal, result: IngestResult): void {
    const threshold = this.effectiveWatermark(pending.captureInstance);
    if (threshold === undefined) {
      return;
    }
    const view = this.pendingView(pending);
    const gap: GapReport = {
      kind: "gap",
      type: "gap",
      reason: "cleanup-watermark",
      captureInstance: pending.captureInstance,
      key: pending.key,
      lsn: pending.lsn,
      lsnKey: pending.lsnKey,
      seqval: pending.seqval,
      seqvalKey: pending.seqvalKey,
      missing: view.missing,
      watermark: threshold,
      pending: view,
    };
    const stateEntry: GapStateEntry = {
      key: pending.key,
      captureInstance: pending.captureInstance,
      lsn: pending.lsn,
      lsnKey: pending.lsnKey,
      seqval: pending.seqval,
      seqvalKey: pending.seqvalKey,
      reason: "cleanup-watermark",
      missing: view.missing,
      watermark: threshold,
    };
    this.internals.gaps.set(pending.key, stateEntry);
    result.gaps.push(gap);
    this.internals.onGap?.(gap);
  }

  private publishSingleRow(
    normalized: NormalizedChangeRow & { schema: CaptureInstanceSchema },
    options: IngestOptions,
    result: IngestResult,
  ): void {
    const include =
      options.includeSingleRowChanges ?? this.internals.includeSingleRowChanges;
    const operation = normalized.operation;
    const entry: PublishedEntry = {
      key: normalized.key,
      captureInstance: normalized.captureInstance as string,
      lsn: normalized.startLsn,
      lsnKey: normalized.lsnKey,
      seqval: normalized.seqval,
      seqvalKey: normalized.seqvalKey,
      kind: operation === CdcOperation.DELETE ? "delete" : "insert",
    };
    this.internals.published.set(normalized.key, entry);
    if (!include) {
      return;
    }

    const change: SingleRowChange = {
      kind: operation === CdcOperation.DELETE ? "delete" : "insert",
      type: operation === CdcOperation.DELETE ? "delete" : "insert",
      captureInstance: normalized.captureInstance as string,
      lsn: normalized.startLsn,
      lsnKey: normalized.lsnKey,
      seqval: normalized.seqval,
      seqvalKey: normalized.seqvalKey,
      key: normalized.key,
      operation: operation as SingleRowChange["operation"],
      schema: normalized.schema,
      row: normalized.raw,
      values: projectCaptureRow(normalized.raw, normalized.schema),
    };
    result.changes.push(change);
    if (change.kind === "insert") {
      result.inserts.push(change);
    } else {
      result.deletes.push(change);
    }
    result.didPublish = true;
    this.internals.onChange?.(change);
  }

  private publishUpdate(
    pending: PendingInternal,
    schema: CaptureInstanceSchema,
    result: IngestResult,
  ): void {
    const before = pending.before as CdcChangeRow;
    const after = pending.after as CdcChangeRow;
    const beforeMaskRaw = firstPresent(before, ["__$update_mask", "update_mask", "updateMask"]);
    const afterMaskRaw = firstPresent(after, ["__$update_mask", "update_mask", "updateMask"]);
    const beforeMask =
      maskValueIsEmpty(beforeMaskRaw)
        ? undefined
        : toMaskBytes(beforeMaskRaw as Parameters<typeof toMaskBytes>[0]);
    const afterMask =
      maskValueIsEmpty(afterMaskRaw)
        ? undefined
        : toMaskBytes(afterMaskRaw as Parameters<typeof toMaskBytes>[0]);

    // The after-image mask is authoritative.  A zero after mask is common on
    // drivers that omit it, so the before mask is used as a fallback.
    let updateMask: Uint8Array | undefined;
    if (afterMask !== undefined && maskHasAnyBit(afterMask)) {
      updateMask = afterMask;
    } else if (beforeMask !== undefined && maskHasAnyBit(beforeMask)) {
      updateMask = beforeMask;
    } else if (afterMask !== undefined) {
      updateMask = afterMask;
    } else if (beforeMask !== undefined) {
      updateMask = beforeMask;
    }

    const beforeValues = projectCaptureRow(before, schema);
    const afterValues = projectCaptureRow(after, schema);
    let changedColumns: string[];
    if (updateMask === undefined) {
      changedColumns = inferChangedColumns(beforeValues, afterValues, schema);
    } else {
      changedColumns = decodeUpdateMask(updateMask, schema);
    }

    const mergedValues =
      updateMask === undefined
        ? this.applyInferredMask(beforeValues, afterValues, changedColumns, schema)
        : applyUpdateMask(beforeValues, afterValues, updateMask, schema);

    const event: MergedUpdate = {
      kind: "update",
      type: "update",
      captureInstance: pending.captureInstance,
      lsn: pending.lsn,
      lsnKey: pending.lsnKey,
      seqval: pending.seqval,
      seqvalKey: pending.seqvalKey,
      key: pending.key,
      operation: CdcOperation.UPDATE_AFTER,
      schema,
      before,
      after,
      beforeImage: before,
      afterImage: after,
      beforeValues,
      afterValues,
      values: afterValues,
      mergedValues,
      changedColumns,
      updatedColumns: changedColumns,
      columns: changedColumns,
      updateMask: updateMask ?? new Uint8Array(0),
      mask:
        updateMask === undefined
          ? "0x"
          : `0x${Array.from(updateMask, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
      maskHex: "",
      ordinals: schema.columns
        .filter((column) => changedColumns.includes(column.name))
        .map((column) => column.ordinal),
    };
    event.maskHex = event.mask;

    this.internals.pending.delete(pending.key);
    this.internals.published.set(pending.key, {
      key: pending.key,
      captureInstance: pending.captureInstance,
      lsn: pending.lsn,
      lsnKey: pending.lsnKey,
      seqval: pending.seqval,
      seqvalKey: pending.seqvalKey,
      kind: "update",
    });

    result.changes.push(event);
    result.updates.push(event);
    result.didPublish = true;
    this.internals.onChange?.(event);
  }

  private applyInferredMask(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    changedColumns: readonly string[],
    schema: CaptureInstanceSchema,
  ): Record<string, unknown> {
    const changed = new Set(changedColumns);
    const result: Record<string, unknown> = { ...before };
    for (const column of schema.columns) {
      if (changed.has(column.name) && Object.prototype.hasOwnProperty.call(after, column.name)) {
        result[column.name] = after[column.name];
      }
    }
    return result;
  }

  private recordDuplicate(result: IngestResult, duplicate: DuplicateReport): void {
    result.duplicates.push(duplicate);
    this.internals.onDuplicate?.(duplicate);
  }

  listPending(): PendingChange[] {
    return [...this.internals.pending.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .map((pending) => this.pendingView(pending));
  }

  getPending(): PendingChange[] {
    return this.listPending();
  }

  pendingChanges(): PendingChange[] {
    return this.listPending();
  }

  getPendingChanges(): PendingChange[] {
    return this.listPending();
  }

  private pendingView(pending: PendingInternal): PendingChange {
    const missing: Array<"before" | "after"> = [];
    if (pending.before === undefined) {
      missing.push("before");
    }
    if (pending.after === undefined) {
      missing.push("after");
    }
    const view: PendingChange = {
      kind: "pending",
      captureInstance: pending.captureInstance,
      key: pending.key,
      lsn: pending.lsn,
      lsnKey: pending.lsnKey,
      seqval: pending.seqval,
      seqvalKey: pending.seqvalKey,
      missing,
      sequence: pending.sequence,
    };
    if (pending.before !== undefined) {
      view.before = pending.before;
    }
    if (pending.after !== undefined) {
      view.after = pending.after;
    }
    return view;
  }

  /**
   * Advance the cleanup watermark.  Pending halves strictly below the
   * watermark can no longer be completed by CDC and are reported as permanent
   * gaps.  Watermarks are monotonic; a lower value is ignored.
   */
  advanceWatermark(watermark: BinaryLike, captureInstance?: string): GapReport[] {
    const normalized = normalizeLsn(watermark);
    if (captureInstance === undefined) {
      if (
        this.internals.globalWatermark === undefined ||
        compareLsn(normalized, this.internals.globalWatermark) >= 0
      ) {
        this.internals.globalWatermark = normalized;
      }
    } else {
      const current = this.internals.instanceWatermarks.get(captureInstance);
      if (current === undefined || compareLsn(normalized, current) >= 0) {
        this.internals.instanceWatermarks.set(captureInstance, normalized);
      }
    }

    const gaps: GapReport[] = [];
    const gapResult: IngestResult = { ...emptyResult(), gaps };
    for (const pending of [...this.internals.pending.values()]) {
      if (captureInstance !== undefined && pending.captureInstance !== captureInstance) {
        continue;
      }
      if (!this.isExpired(pending.lsnKey, pending.captureInstance)) {
        continue;
      }

      this.internals.pending.delete(pending.key);
      this.reportGap(pending, gapResult);
    }
    gaps.sort(compareGaps);
    return gaps;
  }

  private maxWatermark(
    first: string | undefined,
    second: string | undefined,
  ): string | undefined {
    if (first === undefined) {
      return second;
    }
    if (second === undefined) {
      return first;
    }
    return compareLsn(first, second) >= 0 ? first : second;
  }

  /** Alias used by service integrations. */
  setCleanupWatermark(watermark: BinaryLike, captureInstance?: string): GapReport[] {
    return this.advanceWatermark(watermark, captureInstance);
  }

  advanceCleanupWatermark(watermark: BinaryLike, captureInstance?: string): GapReport[] {
    return this.advanceWatermark(watermark, captureInstance);
  }

  updateWatermark(watermark: BinaryLike, captureInstance?: string): GapReport[] {
    return this.advanceWatermark(watermark, captureInstance);
  }

  /** Alias used by cleanup jobs. */
  cleanup(watermark: BinaryLike, captureInstance?: string): GapReport[] {
    return this.advanceWatermark(watermark, captureInstance);
  }

  /** Alias for a periodic gap sweep. */
  sweepWatermark(watermark: BinaryLike, captureInstance?: string): GapReport[] {
    return this.advanceWatermark(watermark, captureInstance);
  }

  listGaps(): GapStateEntry[] {
    return [...this.internals.gaps.values()];
  }

  getGaps(): GapStateEntry[] {
    return this.listGaps();
  }

  listPublished(): PublishedEntry[] {
    return [...this.internals.published.values()];
  }

  getPublished(): PublishedEntry[] {
    return this.listPublished();
  }

  isPublished(key: string): boolean {
    return this.internals.published.has(key);
  }

  /**
   * Persist pending halves, the published-key set, gaps, and watermarks.
   * The returned object is JSON-safe.
   */
  snapshot(): MergerState {
    const state: MergerState = {
      version: 1,
      captureInstance: this.internals.defaultCaptureInstance,
      schemas: [...this.internals.schemas.values()].map(
        (schema): SerializedSchema => ({
          captureInstance: schema.captureInstance,
          columns: schema.columns.map((column) => ({
            ordinal: column.ordinal,
            name: column.name,
            ...(column.type === undefined ? {} : { type: column.type }),
            ...(column.nullable === undefined ? {} : { nullable: column.nullable }),
          })),
        }),
      ),
      watermark: this.internals.globalWatermark ?? null,
      instanceWatermarks: Object.fromEntries(this.internals.instanceWatermarks),
      published: this.listPublished().map((entry) => ({ ...entry })),
      gaps: this.listGaps().map((entry) => ({ ...entry, missing: [...entry.missing] })),
      pending: [...this.internals.pending.values()]
        .sort((left, right) => left.sequence - right.sequence)
        .map((pending): SerializedPending => {
          const serialized: SerializedPending = {
            key: pending.key,
            captureInstance: pending.captureInstance,
            lsn: pending.lsn,
            lsnKey: pending.lsnKey,
            seqval: pending.seqval,
            seqvalKey: pending.seqvalKey,
            sequence: pending.sequence,
          };
          if (pending.before !== undefined) {
            serialized.before = encodeBinaryForJson(pending.before) as Record<string, unknown>;
          }
          if (pending.after !== undefined) {
            serialized.after = encodeBinaryForJson(pending.after) as Record<string, unknown>;
          }
          return serialized;
        }),
    };
    return state;
  }

  toJSON(): MergerState {
    return this.snapshot();
  }

  saveState(): string {
    return JSON.stringify(this.snapshot());
  }

  exportState(): MergerState {
    return this.snapshot();
  }

  serialize(): string {
    return this.saveState();
  }

  load(stateOrJson: MergerState | string): this {
    const state =
      typeof stateOrJson === "string"
        ? (JSON.parse(stateOrJson) as MergerState)
        : stateOrJson;
    return this.restore(state);
  }

  importState(stateOrJson: MergerState | string): this {
    return this.load(stateOrJson);
  }

  restore(state: MergerState): this {
    if (state === null || typeof state !== "object") {
      throw new TypeError("Merger state must be an object");
    }
    if (state.version !== undefined && state.version !== 1) {
      throw new TypeError(`Unsupported merger state version: ${String(state.version)}`);
    }

    this.internals.published.clear();
    this.internals.gaps.clear();
    this.internals.pending.clear();
    this.internals.instanceWatermarks.clear();
    this.internals.globalWatermark = state.watermark ?? undefined;
    this.internals.defaultCaptureInstance =
      state.captureInstance ?? this.internals.defaultCaptureInstance;
    this.internals.sequence = 0;

    for (const serialized of state.schemas ?? []) {
      if (serialized.captureInstance === undefined || !Array.isArray(serialized.columns)) {
        continue;
      }
      if (this.internals.schemas.has(serialized.captureInstance)) {
        continue;
      }
      const schema = normalizeSchema(
        serialized as unknown as CaptureSchemaLike,
        serialized.captureInstance,
      );
      this.internals.schemas.set(schema.captureInstance, schema);
      if (this.internals.fallbackSchema === undefined) {
        this.internals.fallbackSchema = schema;
      }
    }

    for (const entry of state.published ?? []) {
      if (typeof entry.key !== "string") {
        throw new TypeError("Invalid published entry in merger state");
      }
      this.internals.published.set(entry.key, {
        ...entry,
        lsnKey: entry.lsnKey ?? canonicalLsn(entry.lsn),
        seqvalKey: entry.seqvalKey ?? canonicalLsn(entry.seqval),
      });
    }
    for (const entry of state.gaps ?? []) {
      if (typeof entry.key !== "string") {
        throw new TypeError("Invalid gap entry in merger state");
      }
      this.internals.gaps.set(entry.key, {
        ...entry,
        reason: entry.reason ?? "cleanup-watermark",
        lsnKey: entry.lsnKey ?? canonicalLsn(entry.lsn),
        seqvalKey: entry.seqvalKey ?? canonicalLsn(entry.seqval),
      });
    }
    for (const [instance, watermark] of Object.entries(state.instanceWatermarks ?? {})) {
      this.internals.instanceWatermarks.set(instance, watermark);
    }
    for (const entry of state.pending ?? []) {
      if (typeof entry.key !== "string") {
        throw new TypeError("Invalid pending entry in merger state");
      }
      const pending: PendingInternal = {
        key: entry.key,
        captureInstance: entry.captureInstance,
        lsn: entry.lsn,
        lsnKey: entry.lsnKey ?? canonicalLsn(entry.lsn),
        seqval: entry.seqval,
        seqvalKey: entry.seqvalKey ?? canonicalLsn(entry.seqval),
        sequence: entry.sequence ?? this.internals.sequence,
      };
      if (entry.before !== undefined) {
        pending.before = decodeBinaryFromJson(entry.before) as CdcChangeRow;
      }
      if (entry.after !== undefined) {
        pending.after = decodeBinaryFromJson(entry.after) as CdcChangeRow;
      }
      this.internals.pending.set(entry.key, pending);
      this.internals.sequence = Math.max(this.internals.sequence, pending.sequence + 1);
    }
    return this;
  }

  static fromState(options: MergerOptions): CdcChangeMerger {
    return new CdcChangeMerger(options);
  }

  /**
   * Drop published/gap bookkeeping below a watermark.  This is optional: the
   * merger keeps the sets indefinitely by default so replay is always safe.
   */
  pruneBefore(watermark: BinaryLike, captureInstance?: string): number {
    let removed = 0;
    for (const [key, entry] of this.internals.published) {
      if (captureInstance !== undefined && entry.captureInstance !== captureInstance) {
        continue;
      }
      if (compareLsn(entry.lsnKey, watermark) < 0) {
        this.internals.published.delete(key);
        removed += 1;
      }
    }
    for (const [key, entry] of this.internals.gaps) {
      if (captureInstance !== undefined && entry.captureInstance !== captureInstance) {
        continue;
      }
      if (compareLsn(entry.lsnKey, watermark) < 0) {
        this.internals.gaps.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

/** Alias used by some integrations. */
export { CdcChangeMerger as UpdateMaskMerger };
export { CdcChangeMerger as CdcUpdateMerger };
export { CdcChangeMerger as UpdateMerger };
export { CdcChangeMerger as ChangeMerger };
export { CdcChangeMerger as UpdateMaskInterpreter };
export { CdcChangeMerger as UpdateMaskDecoder };
export { CdcChangeMerger as CdcPairer };

/**
 * Functional convenience wrapper: pair a finite batch of rows and optionally
 * apply cleanup watermarks.  This is useful for tests and offline replays.
 */
export function mergeCdcRows(
  rows: readonly CdcChangeRow[],
  schema: CaptureSchemaLike,
  options: MergeRowsOptions = {},
): IngestResult {
  const {
    watermark,
    cleanupWatermark,
    instanceWatermarks,
    ...mergerOptions
  } = options;
  const merger = new CdcChangeMerger({
    ...mergerOptions,
    schema,
  });
  const result = merger.ingestMany(rows, {
    captureInstance: options.captureInstance,
  });
  const gaps: GapReport[] = [];
  const initialWatermark = cleanupWatermark ?? watermark;
  if (initialWatermark !== undefined) {
    gaps.push(...merger.advanceWatermark(initialWatermark));
  }
  for (const [instance, instanceWatermark] of Object.entries(instanceWatermarks ?? {})) {
    gaps.push(...merger.advanceWatermark(instanceWatermark, instance));
  }
  if (gaps.length > 0) {
    result.gaps.push(...gaps);
    result.gaps.sort(compareGaps);
  }
  result.pending = merger.listPending();
  result.didPublish = result.changes.length > 0;
  return finalizeResult(result);
}

export const mergeChanges = mergeCdcRows;
export const pairUpdateRows = mergeCdcRows;
export const pairChanges = mergeCdcRows;
export const mergeUpdateRows = mergeCdcRows;
export const mergeCdcChanges = mergeCdcRows;
export const mergeRows = mergeCdcRows;
export const processCdcRows = mergeCdcRows;
export const pairRows = mergeCdcRows;
export const pairBeforeAfter = mergeCdcRows;

/** Decode a mask for a one-off row, with schema resolution included. */
export function updatedColumnsForRow(
  row: CdcChangeRow,
  schema: CaptureSchemaLike,
): string[] {
  const rawMask = firstPresent(row, ["__$update_mask", "update_mask", "updateMask"]);
  if (rawMask === undefined || rawMask === null) {
    return [];
  }
  return decodeUpdateMask(
    rawMask as UpdateMaskArgument,
    schema,
  );
}

export function captureColumnNames(schema: CaptureSchemaLike): string[] {
  return schemaColumnNames(normalizeSchema(schema));
}

export function operationName(operation: CdcOperationInput): CdcOperationValue {
  return normalizeOperation(operation);
}
