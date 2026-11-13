/**
 * Cursor pagination with overlap/loop handling, version-aware deduplication
 * and resumable checkpoints.
 *
 * The pager deliberately separates fetching from acknowledging data:
 *
 *   1. `nextBatch()` fetches one or more pages into an uncommitted batch.
 *   2. The caller writes/processes the records.
 *   3. `commit(batch)` persists the cursor and committed watermark.
 *
 * If the process dies before step 3, the batch is fetched again from the last
 * committed checkpoint. Records that are already committed are filtered by
 * the watermark (and by the in-memory key/version index).
 */

export type Cursor = string | number | null;

export type FetchReason = "initial" | "next" | "recovery";

export type StopReason = "end" | "cursor-loop" | "max-pages";

export type SnapshotExpiryPolicy = "resume" | "restart" | "throw";

export type CursorLoopPolicy = "stop" | "throw";

export interface Page<T> {
  items: readonly T[];
  /** Cursor for the next page. `null`/`undefined` terminates the scan. */
  nextCursor?: Cursor;
  /** Optional rotating snapshot token returned by the API. */
  snapshotToken?: string | null;
  /** Set to false when the API knows this was the final page. */
  hasMore?: boolean;
}

export interface FetchPageRequest {
  cursor: Cursor;
  snapshotToken: string | null;
  reason: FetchReason;
  /** Number of attempts made at this cursor since the last recovery. */
  attempt: number;
}

export interface Checkpoint<V = unknown> {
  /** Scan position to resume from. */
  cursor: Cursor;
  /** Highest version that has been successfully committed. */
  watermark: V | null;
  /**
   * Keys committed at exactly `watermark`.  This disambiguates equal versions
   * during a full rescan without having to persist every key ever seen.
   */
  watermarkKeys?: readonly unknown[];
  /** Snapshot token is persisted so an uninterrupted snapshot can be reused. */
  snapshotToken?: string | null;
  /** True once a scan ended cleanly (or could not make progress). */
  exhausted?: boolean;
}

export interface CheckpointStore<V = unknown> {
  load(): Promise<Checkpoint<V> | null | undefined> | Checkpoint<V> | null | undefined;
  /**
   * Persist the complete checkpoint as one value. Implementations should
   * overwrite atomically; do not save the cursor and watermark separately.
   */
  save(checkpoint: Checkpoint<V>): Promise<void> | void;
}

export interface CursorBatch<T, K = string, V = unknown> {
  /** Deduplicated records from this uncommitted batch, in source order. */
  readonly records: readonly T[];
  /** Deduplication keys, parallel to `records`. */
  readonly keys: readonly K[];
  /** State that will be persisted by `commit()`. */
  readonly cursor: Cursor;
  readonly watermark: V | null;
  readonly snapshotToken: string | null;
  /** True when no further pages are available for this scan. */
  readonly done: boolean;
  readonly stopReason: StopReason | null;
  readonly fetchedPages: number;
  readonly duplicatesSkipped: number;
  /** Number of uncommitted records replaced by a newer version. */
  readonly replaced: number;
}

export interface RunSummary<V = unknown> {
  batches: number;
  records: number;
  fetchedPages: number;
  duplicatesSkipped: number;
  replaced: number;
  snapshotRecoveries: number;
  stopReason: StopReason | null;
  checkpoint: Checkpoint<V>;
}

export interface SnapshotExpiredEvent {
  error: unknown;
  /** Cursor whose page could not be fetched with the expired snapshot. */
  cursor: Cursor;
  recovery: number;
}

export interface CursorPagerOptions<T, K = string, V = unknown> {
  fetchPage(request: FetchPageRequest): Promise<Page<T>>;
  /** Stable identity supplied by the caller. */
  getKey(item: T): K;
  /**
   * Record version used for "newer wins" and for the committed watermark.
   * When omitted, common fields such as `version`, `revision`, `updatedAt`
   * and `updated_at` are detected automatically.
   */
  getVersion?(item: T): V;
  compareVersions?(a: V, b: V): number;
  checkpointStore?: CheckpointStore<V>;
  initialCheckpoint?: Checkpoint<V> | null;
  /** Soft maximum number of unique records in a batch (a page is never split). */
  batchSize?: number;
  /** Safety bound for the whole scan. Defaults to Infinity. */
  maxPages?: number;
  /** Defaults to 5. */
  maxSnapshotRecoveries?: number;
  /**
   * How to recover after `SNAPSHOT_EXPIRED`:
   * - `resume` (default): retry from the last committed cursor, falling back
   *   to the beginning if that cursor is rejected too.
   * - `restart`: rescan from the beginning and rely on the watermark.
   * - `throw`: surface the API error.
   */
  snapshotExpiryPolicy?: SnapshotExpiryPolicy;
  /** Defaults to `stop`: return the page, then end the scan. */
  cursorLoopPolicy?: CursorLoopPolicy;
  /** Overrides the built-in snapshot-expiry detector when provided. */
  isSnapshotExpired?(error: unknown): boolean;
  /** Overrides the built-in invalid-cursor detector when provided. */
  isInvalidCursor?(error: unknown): boolean;
  onSnapshotExpired?(event: SnapshotExpiredEvent): void | Promise<void>;
  /**
   * Optional handler used by `run()`. It must finish processing before the
   * checkpoint is committed. `nextBatch()`/`commit()` callers may omit it.
   */
  onBatch?(records: readonly T[], batch: CursorBatch<T, K, V>): void | Promise<void>;
}

export class CursorPaginationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CursorPaginationError";
  }
}

export class SnapshotExpiredError extends CursorPaginationError {
  readonly code = "SNAPSHOT_EXPIRED";
  readonly snapshotToken: string | null;

  constructor(
    message = "Snapshot token expired",
    options?: ErrorOptions & { snapshotToken?: string | null },
  ) {
    super(message, options);
    this.name = "SnapshotExpiredError";
    this.snapshotToken = options?.snapshotToken ?? null;
  }
}

export class SnapshotRecoveryError extends CursorPaginationError {
  readonly recoveries: number;

  constructor(message: string, recoveries: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "SnapshotRecoveryError";
    this.recoveries = recoveries;
  }
}

export class InvalidCursorError extends CursorPaginationError {
  readonly code = "INVALID_CURSOR";

  constructor(message = "Cursor is no longer valid", options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidCursorError";
  }
}

export class CursorLoopError extends CursorPaginationError {
  readonly cursor: Cursor;
  readonly visited: readonly Cursor[];

  constructor(cursor: Cursor, visited: readonly Cursor[], options?: ErrorOptions) {
    super(`Cursor loop detected at ${String(cursor)}`, options);
    this.name = "CursorLoopError";
    this.cursor = cursor;
    this.visited = [...visited];
  }
}

export class PageFormatError extends CursorPaginationError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PageFormatError";
  }
}

export class PendingBatchError extends CursorPaginationError {
  constructor() {
    super("The current batch must be committed or aborted before fetching another page");
    this.name = "PendingBatchError";
  }
}

export class BatchStateError extends CursorPaginationError {
  constructor(message = "Batch does not belong to this pager or is no longer active") {
    super(message);
    this.name = "BatchStateError";
  }
}

const VERSION_FIELDS = [
  "version",
  "revision",
  "rev",
  "sequence",
  "seq",
  "updatedAt",
  "updated_at",
  "updated",
  "modifiedAt",
  "modified_at",
] as const;

function inferVersion(item: unknown): unknown {
  if (item === null || typeof item !== "object") {
    return undefined;
  }

  const record = item as Record<string, unknown>;
  for (const field of VERSION_FIELDS) {
    const value = record[field];
    if (
      typeof value === "number" ||
      typeof value === "string" ||
      typeof value === "bigint" ||
      value instanceof Date
    ) {
      return value;
    }
  }
  return undefined;
}

/**
 * Compare common version representations. Callers with custom version
 * semantics (for example semantic versions) should pass `compareVersions`.
 */
export function compareVersionValues(a: unknown, b: unknown): number {
  if (Object.is(a, b)) {
    return 0;
  }

  if (typeof a === "number" && typeof b === "number") {
    return a < b ? -1 : 1;
  }
  if (typeof a === "bigint" && typeof b === "bigint") {
    return a < b ? -1 : 1;
  }
  if (a instanceof Date || b instanceof Date) {
    const left =
      a instanceof Date
        ? a.getTime()
        : typeof a === "number"
          ? a
          : typeof a === "string"
            ? Date.parse(a)
            : Number.NaN;
    const right =
      b instanceof Date
        ? b.getTime()
        : typeof b === "number"
          ? b
          : typeof b === "string"
            ? Date.parse(b)
            : Number.NaN;
    if (Number.isFinite(left) && Number.isFinite(right)) {
      return left < right ? -1 : 1;
    }
  }
  if (typeof a === "string" && typeof b === "string") {
    if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(a) && /^-?(?:\d+\.?\d*|\.\d+)$/.test(b)) {
      const left = Number(a);
      const right = Number(b);
      if (left !== right) {
        return left < right ? -1 : 1;
      }
      return 0;
    }
    return a < b ? -1 : 1;
  }

  throw new TypeError(
    "Unsupported version values; provide CursorPagerOptions.compareVersions",
  );
}

function normalizeCursor(cursor: Cursor | undefined): Cursor {
  if (cursor === undefined || cursor === null) {
    return null;
  }
  if (typeof cursor !== "string" && typeof cursor !== "number") {
    throw new PageFormatError(
      `Cursor must be a string, number or null; received ${typeof cursor}`,
    );
  }
  return cursor;
}

function normalizeCheckpoint<V>(checkpoint: Checkpoint<V>): Checkpoint<V> {
  if (checkpoint === null || typeof checkpoint !== "object") {
    throw new CursorPaginationError("Checkpoint must be an object");
  }
  return {
    cursor: normalizeCursor(checkpoint.cursor),
    watermark: checkpoint.watermark ?? null,
    watermarkKeys: Array.isArray(checkpoint.watermarkKeys)
      ? [...checkpoint.watermarkKeys]
      : [],
    snapshotToken:
      typeof checkpoint.snapshotToken === "string" ? checkpoint.snapshotToken : null,
    exhausted: checkpoint.exhausted === true,
  };
}

function tokenFromError(error: unknown): string | null {
  if (error === null || typeof error !== "object") {
    return null;
  }
  const candidate = error as {
    snapshotToken?: unknown;
    response?: { snapshotToken?: unknown };
  };
  if (typeof candidate.snapshotToken === "string") {
    return candidate.snapshotToken;
  }
  if (typeof candidate.response?.snapshotToken === "string") {
    return candidate.response.snapshotToken;
  }
  return null;
}

export function isSnapshotExpiredError(error: unknown): boolean {
  if (error instanceof SnapshotExpiredError) {
    return true;
  }
  if (error === null || typeof error !== "object") {
    return false;
  }

  const candidate = error as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    snapshotExpired?: unknown;
    response?: { status?: unknown };
    message?: unknown;
  };

  if (candidate.name === "SnapshotExpiredError" || candidate.snapshotExpired === true) {
    return true;
  }
  if (
    candidate.code === "SNAPSHOT_EXPIRED" ||
    candidate.code === "SNAPSHOT_TOKEN_EXPIRED" ||
    candidate.code === "EXPIRED_SNAPSHOT"
  ) {
    return true;
  }
  if (
    candidate.status === 410 ||
    candidate.statusCode === 410 ||
    candidate.response?.status === 410
  ) {
    return true;
  }
  return (
    typeof candidate.message === "string" &&
    /snapshot(?:\s+token)?\s+(?:has\s+)?expired|expired\s+snapshot|snapshot.*(?:invalid|stale)/i.test(
      candidate.message,
    )
  );
}

export function isInvalidCursorError(error: unknown): boolean {
  if (error instanceof InvalidCursorError) {
    return true;
  }
  if (error === null || typeof error !== "object") {
    return false;
  }

  const candidate = error as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
  };

  if (candidate.name === "InvalidCursorError") {
    return true;
  }
  if (
    candidate.code === "INVALID_CURSOR" ||
    candidate.code === "CURSOR_EXPIRED" ||
    candidate.code === "CURSOR_INVALID"
  ) {
    return true;
  }
  if (candidate.status === 400 || candidate.statusCode === 400) {
    return (
      typeof candidate.message === "string" && /cursor/i.test(candidate.message)
    );
  }
  return (
    typeof candidate.message === "string" &&
    /(?:invalid|expired|stale)\s+cursor|cursor\s+(?:is\s+)?(?:invalid|expired|stale)/i.test(
      candidate.message,
    )
  );
}

interface StagedRecord<T, K, V> {
  key: K;
  item: T;
  version: V | undefined;
}

interface ActiveBatch<T, K, V> {
  batch: CursorBatch<T, K, V>;
  versions: Array<V | undefined>;
}

/**
 * Pull-based cursor pager. A batch is only acknowledged when `commit()` has
 * persisted the checkpoint successfully.
 */
export class CursorPager<T, K = string, V = unknown> {
  private readonly options: CursorPagerOptions<T, K, V>;
  private readonly batchSize: number;
  private readonly maxPages: number;
  private readonly maxSnapshotRecoveries: number;
  private readonly compare: (a: V, b: V) => number;
  private readonly versionOf: (item: T) => V | undefined;
  private readonly expires: (error: unknown) => boolean;
  private readonly invalidCursor: (error: unknown) => boolean;

  private checkpointState: Checkpoint<V> = {
    cursor: null,
    watermark: null,
    snapshotToken: null,
    exhausted: false,
  };

  private initialized = false;
  private initializing: Promise<void> | null = null;

  private readonly pending = new Map<K, StagedRecord<T, K, V>>();
  private readonly committedVersions = new Map<K, V | undefined>();
  private readonly committedAtWatermark = new Set<K>();
  private readonly seenCursors = new Set<Cursor>();
  private readonly cursorHistory: Cursor[] = [];
  private readonly recoveryAttempts = new Map<Cursor, number>();
  private readonly committedBatches = new WeakSet<object>();

  private scanCursor: Cursor = null;
  private snapshotToken: string | null = null;
  private done = false;
  private stopReason: StopReason | null = null;
  private fetchReason: FetchReason = "initial";
  private activeBatch: ActiveBatch<T, K, V> | null = null;
  private committing = false;

  private pagesFetched = 0;
  private snapshotRecoveries = 0;

  private batchDuplicates = 0;
  private batchReplaced = 0;

  constructor(options: CursorPagerOptions<T, K, V>) {
    if (typeof options.fetchPage !== "function") {
      throw new TypeError("fetchPage must be a function");
    }
    if (typeof options.getKey !== "function") {
      throw new TypeError("getKey must be a function");
    }

    const batchSize = options.batchSize ?? 100;
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new RangeError("batchSize must be a positive integer");
    }
    const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
    if (!(maxPages > 0)) {
      throw new RangeError("maxPages must be greater than zero");
    }
    const maxRecoveries = options.maxSnapshotRecoveries ?? 5;
    if (!Number.isInteger(maxRecoveries) || maxRecoveries < 0) {
      throw new RangeError("maxSnapshotRecoveries must be a non-negative integer");
    }

    this.options = options;
    this.batchSize = batchSize;
    this.maxPages = maxPages;
    this.maxSnapshotRecoveries = maxRecoveries;
    this.compare = options.compareVersions ?? compareVersionValues;
    this.versionOf =
      options.getVersion ??
      ((item: T) => inferVersion(item) as V | undefined);
    this.expires = options.isSnapshotExpired ?? isSnapshotExpiredError;
    this.invalidCursor = options.isInvalidCursor ?? isInvalidCursorError;
  }

  /** Synchronous view of the last durable checkpoint. */
  get checkpoint(): Readonly<Checkpoint<V>> {
    return { ...this.checkpointState };
  }

  /** Snapshot used by the current scan (may be newer than the checkpoint). */
  get currentSnapshotToken(): string | null {
    return this.snapshotToken;
  }

  /** Load a checkpoint from the store (if configured). */
  async loadCheckpoint(): Promise<Checkpoint<V>> {
    await this.ensureInitialized();
    return { ...this.checkpointState };
  }

  /**
   * Fetch the next uncommitted batch. A page is never split, so the returned
   * cursor always covers every record in the batch.
   */
  async nextBatch(): Promise<CursorBatch<T, K, V> | null> {
    await this.ensureInitialized();

    if (this.activeBatch !== null) {
      throw new PendingBatchError();
    }
    if (this.done && this.pending.size === 0) {
      return null;
    }

    const pagesBefore = this.pagesFetched;
    this.batchDuplicates = 0;
    this.batchReplaced = 0;

    try {
      while (!this.done && this.pending.size < this.batchSize) {
        if (this.pagesFetched >= this.maxPages) {
          this.finish("max-pages");
          break;
        }

        const page = await this.fetchPageWithRecovery();
        this.pagesFetched += 1;
        this.processPage(page);
        this.advance(page);
      }
    } catch (error) {
      // No records from this attempt were handed to the caller. Rewinding to
      // the durable checkpoint makes a retry safe and prevents skipped rows.
      this.rollbackUncommitted();
      throw error;
    }

    if (
      this.pending.size === 0 &&
      this.pagesFetched === pagesBefore &&
      !this.done
    ) {
      return null;
    }

    const staged = [...this.pending.values()];
    const records = staged.map((entry) => entry.item);
    const keys = staged.map((entry) => entry.key);
    const versions = staged.map((entry) => entry.version);
    const watermark = this.computeWatermark(versions);

    const batch: CursorBatch<T, K, V> = Object.freeze({
      records: Object.freeze(records),
      keys: Object.freeze(keys),
      cursor: this.scanCursor,
      watermark,
      snapshotToken: this.snapshotToken,
      done: this.done,
      stopReason: this.stopReason,
      fetchedPages: this.pagesFetched - pagesBefore,
      duplicatesSkipped: this.batchDuplicates,
      replaced: this.batchReplaced,
    });

    this.activeBatch = { batch, versions };
    return batch;
  }

  /**
   * Persist the batch checkpoint. Call this only after the records have been
   * processed successfully. Repeating `commit()` with the same batch is a
   * no-op after a successful save.
   */
  async commit(batch: CursorBatch<T, K, V>): Promise<void> {
    await this.ensureInitialized();

    if (this.committedBatches.has(batch)) {
      return;
    }
    if (this.activeBatch === null || this.activeBatch.batch !== batch) {
      throw new BatchStateError();
    }
    if (this.committing) {
      throw new BatchStateError("A checkpoint commit is already in progress");
    }

    this.committing = true;
    const active = this.activeBatch;
    const nextCheckpoint: Checkpoint<V> = {
      cursor: batch.cursor,
      watermark: batch.watermark,
      watermarkKeys: this.nextWatermarkKeys(batch, active.versions),
      snapshotToken: batch.snapshotToken,
      // A max-pages stop is a safety pause, not the end of the source.  Keep
      // the checkpoint resumable from the cursor for the next run.
      exhausted: batch.done && batch.stopReason !== "max-pages",
    };

    try {
      if (this.options.checkpointStore !== undefined) {
        await this.options.checkpointStore.save({ ...nextCheckpoint });
      }

      this.checkpointState = nextCheckpoint;
      this.rebuildWatermarkKeys(nextCheckpoint.watermarkKeys ?? []);
      for (let index = 0; index < batch.keys.length; index += 1) {
        this.committedVersions.set(batch.keys[index], active.versions[index]);
      }
      this.pending.clear();
      this.activeBatch = null;
      this.committedBatches.add(batch);
    } finally {
      this.committing = false;
    }
  }

  /**
   * Discard the current uncommitted work and rewind to the last checkpoint.
   * The next call to `nextBatch()` refetches that range.
   */
  abort(): void {
    this.activeBatch = null;
    this.rollbackUncommitted();
  }

  /**
   * Process every remaining batch through `onBatch`, committing each batch
   * only after the handler succeeds.
   */
  async run(): Promise<RunSummary<V>> {
    if (typeof this.options.onBatch !== "function") {
      throw new CursorPaginationError("run() requires an onBatch handler");
    }

    let batches = 0;
    let records = 0;
    let fetchedPages = 0;
    let duplicatesSkipped = 0;
    let replaced = 0;
    let snapshotRecoveries = 0;
    let stopReason: StopReason | null = null;
    const initialRecoveries = this.snapshotRecoveries;

    for (;;) {
      const batch = await this.nextBatch();
      if (batch === null) {
        break;
      }

      fetchedPages += batch.fetchedPages;
      duplicatesSkipped += batch.duplicatesSkipped;
      replaced += batch.replaced;

      try {
        await this.options.onBatch(batch.records, batch);
      } catch (error) {
        this.abort();
        throw error;
      }

      try {
        await this.commit(batch);
      } catch (error) {
        // Keep the active batch so a caller may retry the same commit.
        throw error;
      }

      batches += 1;
      records += batch.records.length;
      stopReason = batch.stopReason;
    }

    snapshotRecoveries = this.snapshotRecoveries - initialRecoveries;
    if (stopReason === null && this.checkpointState.exhausted === true) {
      stopReason = "end";
    }
    return {
      batches,
      records,
      fetchedPages,
      duplicatesSkipped,
      replaced,
      snapshotRecoveries,
      stopReason,
      checkpoint: { ...this.checkpointState },
    };
  }

  private ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return Promise.resolve();
    }
    if (this.initializing === null) {
      this.initializing = this.initialize().catch((error: unknown) => {
        this.initializing = null;
        throw error;
      });
    }
    return this.initializing;
  }

  private async initialize(): Promise<void> {
    let checkpoint = this.options.initialCheckpoint ?? null;

    if (this.options.checkpointStore !== undefined) {
      const loaded = await this.options.checkpointStore.load();
      if (loaded !== null && loaded !== undefined) {
        checkpoint = loaded;
      }
    }

    if (checkpoint !== null) {
      this.checkpointState = normalizeCheckpoint(checkpoint);
      this.rebuildWatermarkKeys(this.checkpointState.watermarkKeys ?? []);
    }

    this.scanCursor = this.checkpointState.cursor;
    this.snapshotToken = this.checkpointState.snapshotToken ?? null;
    this.done = this.checkpointState.exhausted === true;
    this.stopReason = this.done ? "end" : null;
    this.fetchReason = "initial";

    if (this.scanCursor !== null) {
      this.seenCursors.add(this.scanCursor);
      this.cursorHistory.push(this.scanCursor);
    }

    this.initialized = true;
  }

  private async fetchPageWithRecovery(): Promise<Page<T>> {
    let attempt = 0;

    for (;;) {
      attempt += 1;
      try {
        const page = await this.options.fetchPage({
          cursor: this.scanCursor,
          snapshotToken: this.snapshotToken,
          reason: this.fetchReason,
          attempt,
        });
        this.recoveryAttempts.clear();
        this.fetchReason = "next";
        return page;
      } catch (error) {
        if (this.expires(error)) {
          await this.recoverSnapshot(error);
          attempt = 0;
          continue;
        }

        if (this.scanCursor !== null && this.invalidCursor(error)) {
          this.recoverInvalidCursor(error);
          attempt = 0;
          continue;
        }

        throw error;
      }
    }
  }

  private async recoverSnapshot(error: unknown): Promise<void> {
    if (this.options.snapshotExpiryPolicy === "throw") {
      throw error;
    }

    this.snapshotRecoveries += 1;
    if (this.snapshotRecoveries > this.maxSnapshotRecoveries) {
      throw new SnapshotRecoveryError(
        `Snapshot recovery limit (${this.maxSnapshotRecoveries}) exceeded`,
        this.snapshotRecoveries,
        { cause: error },
      );
    }

    const failedCursor = this.scanCursor;
    const attemptsAtCursor = this.recoveryAttempts.get(failedCursor) ?? 0;
    this.recoveryAttempts.set(failedCursor, attemptsAtCursor + 1);

    if (this.options.onSnapshotExpired !== undefined) {
      await this.options.onSnapshotExpired({
        error,
        cursor: failedCursor,
        recovery: this.snapshotRecoveries,
      });
    }

    // Records in the current, not-yet-returned batch are deliberately
    // discarded. A new snapshot must provide them again from a durable point.
    this.pending.clear();
    this.batchDuplicates = 0;
    this.batchReplaced = 0;

    const policy = this.options.snapshotExpiryPolicy ?? "resume";
    const mustRestart =
      policy === "restart" ||
      attemptsAtCursor > 0 ||
      this.checkpointState.cursor === null;
    const nextCursor = mustRestart ? null : this.checkpointState.cursor;

    this.snapshotToken = tokenFromError(error);
    this.resetScanPosition(nextCursor);
    this.done = false;
    this.stopReason = null;
    this.fetchReason = "recovery";
  }

  private recoverInvalidCursor(error: unknown): void {
    const recoveries = this.snapshotRecoveries + 1;
    if (recoveries > this.maxSnapshotRecoveries) {
      throw new SnapshotRecoveryError(
        `Cursor recovery limit (${this.maxSnapshotRecoveries}) exceeded`,
        recoveries,
        { cause: error },
      );
    }

    this.snapshotRecoveries = recoveries;
    this.pending.clear();
    this.batchDuplicates = 0;
    this.batchReplaced = 0;
    this.snapshotToken = null;
    // A rejected cursor forces a fresh scan. The committed watermark filters
    // records that were already acknowledged under the previous snapshot.
    this.resetScanPosition(null);
    this.done = false;
    this.stopReason = null;
    this.fetchReason = "recovery";
  }

  private resetScanPosition(cursor: Cursor): void {
    this.scanCursor = cursor;
    this.seenCursors.clear();
    this.cursorHistory.length = 0;
    if (cursor !== null) {
      this.seenCursors.add(cursor);
      this.cursorHistory.push(cursor);
    }
  }

  private processPage(page: Page<T>): void {
    if (page === null || typeof page !== "object") {
      throw new PageFormatError("fetchPage must return a page object");
    }
    if (!Array.isArray(page.items)) {
      throw new PageFormatError("Page.items must be an array");
    }
    if (page.snapshotToken === null || typeof page.snapshotToken === "string") {
      this.snapshotToken = page.snapshotToken;
    }

    for (const item of page.items) {
      const key = this.options.getKey(item);
      if (key === null || key === undefined) {
        throw new CursorPaginationError(
          "getKey returned null or undefined; a stable deduplication key is required",
        );
      }

      const version = this.normalizeVersion(this.versionOf(item));
      const existing = this.pending.get(key);

      if (existing !== undefined) {
        if (this.isNewer(version, existing.version)) {
          // Keep the original insertion slot so source ordering remains stable.
          this.pending.set(key, { key, item, version });
          this.batchReplaced += 1;
        } else {
          this.batchDuplicates += 1;
        }
        continue;
      }

      if (this.committedVersions.has(key)) {
        const committedVersion = this.committedVersions.get(key);
        if (
          version !== undefined &&
          (committedVersion === undefined ||
            this.compare(version, committedVersion) > 0)
        ) {
          this.pending.set(key, { key, item, version });
        } else {
          this.batchDuplicates += 1;
        }
        continue;
      }

      if (this.isAtOrBelowWatermark(key, version)) {
        this.batchDuplicates += 1;
        continue;
      }

      this.pending.set(key, { key, item, version });
    }
  }

  private advance(page: Page<T>): void {
    if (page.hasMore === false) {
      this.scanCursor = null;
      this.finish("end");
      return;
    }

    const nextCursor = normalizeCursor(page.nextCursor);
    if (nextCursor === null) {
      if (page.hasMore === true) {
        throw new PageFormatError("Page.hasMore is true but nextCursor is null");
      }
      this.scanCursor = null;
      this.finish("end");
      return;
    }

    if (this.seenCursors.has(nextCursor)) {
      this.scanCursor = nextCursor;
      this.cursorHistory.push(nextCursor);
      if ((this.options.cursorLoopPolicy ?? "stop") === "throw") {
        throw new CursorLoopError(nextCursor, this.cursorHistory);
      }
      this.finish("cursor-loop");
      return;
    }

    this.scanCursor = nextCursor;
    this.seenCursors.add(nextCursor);
    this.cursorHistory.push(nextCursor);
  }

  private finish(reason: StopReason): void {
    this.done = true;
    this.stopReason = reason;
  }

  private computeWatermark(versions: readonly (V | undefined)[]): V | null {
    let watermark = this.checkpointState.watermark;
    for (const version of versions) {
      if (version === undefined) {
        continue;
      }
      if (watermark === null) {
        watermark = version;
      } else if (this.compare(version, watermark) > 0) {
        watermark = version;
      }
    }
    return watermark;
  }

  private normalizeVersion(version: V | undefined): V | undefined {
    return version === null || version === undefined ? undefined : version;
  }

  private isNewer(
    candidate: V | undefined,
    current: V | undefined,
  ): boolean {
    if (candidate === undefined && current === undefined) {
      // Without versions, a later occurrence is treated as the authoritative
      // copy while the record is still uncommitted.
      return true;
    }
    if (candidate === undefined) {
      return false;
    }
    if (current === undefined) {
      return true;
    }
    return this.compare(candidate, current) > 0;
  }

  private isAtOrBelowWatermark(key: K, version: V | undefined): boolean {
    const watermark = this.checkpointState.watermark;
    if (version === undefined || watermark === null) {
      return false;
    }
    const comparison = this.compare(version, watermark);
    if (comparison < 0) {
      return true;
    }
    // Equal versions are ambiguous on a full rescan.  Only keys explicitly
    // recorded at the watermark were confirmed before the checkpoint.
    return comparison === 0 && this.committedAtWatermark.has(key);
  }

  private nextWatermarkKeys(
    batch: CursorBatch<T, K, V>,
    versions: readonly (V | undefined)[],
  ): readonly unknown[] {
    const watermark = batch.watermark;
    if (watermark === null) {
      return [];
    }

    const previous = this.checkpointState.watermark;
    const keys = new Set<unknown>(
      previous !== null && this.compare(watermark, previous) === 0
        ? this.committedAtWatermark
        : [],
    );
    for (let index = 0; index < batch.keys.length; index += 1) {
      const version = versions[index];
      if (version !== undefined && this.compare(version, watermark) === 0) {
        keys.add(batch.keys[index]);
      }
    }
    return [...keys];
  }

  private rebuildWatermarkKeys(keys: readonly unknown[]): void {
    this.committedAtWatermark.clear();
    for (const key of keys) {
      this.committedAtWatermark.add(key as K);
    }
  }

  private rollbackUncommitted(): void {
    this.pending.clear();
    this.batchDuplicates = 0;
    this.batchReplaced = 0;
    this.resetScanPosition(this.checkpointState.cursor);
    this.snapshotToken = this.checkpointState.snapshotToken ?? null;
    this.done = this.checkpointState.exhausted === true;
    this.stopReason = this.done ? "end" : null;
    this.fetchReason = this.pagesFetched === 0 ? "initial" : "next";
  }
}

export { CursorPager as CursorPaginator };

export type CursorPage<T> = Page<T>;
export type CursorCheckpoint<V = unknown> = Checkpoint<V>;

export function createCursorPager<T, K = string, V = unknown>(
  options: CursorPagerOptions<T, K, V>,
): CursorPager<T, K, V> {
  return new CursorPager(options);
}

export const createCursorPaginator = createCursorPager;

/**
 * One-shot convenience helper for bounded datasets. It still commits each
 * batch; callers that need backpressure should use `CursorPager` directly.
 */
export async function collectCursorPages<T, K = string, V = unknown>(
  options: Omit<CursorPagerOptions<T, K, V>, "onBatch">,
): Promise<T[]> {
  const pager = new CursorPager<T, K, V>(options);
  const records: T[] = [];

  for (;;) {
    const batch = await pager.nextBatch();
    if (batch === null) {
      break;
    }
    for (const record of batch.records) {
      records.push(record);
    }
    await pager.commit(batch);
  }

  return records;
}

export default CursorPager;
