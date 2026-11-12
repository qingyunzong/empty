import {
  assertInt64,
  compareIdBytes,
  normalizeTime,
  parseCount,
  splitTimeInterval,
} from "./int64.ts";
import {
  type BucketDelivery,
  type CancelOutcome,
  type Checkpoint,
  type CheckpointStore,
  CheckpointError,
  type CollectedRecord,
  type CollectorOptions,
  type ConfirmResult,
  type DeliveryEvidence,
  INT64_MAX,
  INT64_MIN,
  type Interval,
  type NextResult,
  type RangePage,
  RemoteContractError,
  type RemoteRecord,
  type RetiredSnapshot,
  type SeekPage,
  type Snapshot,
  type SnapshotRemote,
  type SnapshotRequest,
  isSnapshotExpired,
} from "./types.ts";

type SessionState = "active" | "done" | "expired" | "cancelled";

interface NormalizedRangePage {
  readonly total: bigint;
  readonly records: readonly CollectedRecord[];
}

interface NormalizedSeekPage {
  readonly records: readonly CollectedRecord[];
  readonly hasMore: boolean | undefined;
}

function copyInterval(interval: Interval): Interval {
  return { from: interval.from, to: interval.to };
}

function copyCheckpoint(checkpoint: Checkpoint): Checkpoint {
  return {
    version: 1,
    streamId: checkpoint.streamId,
    k: checkpoint.k,
    scan: copyInterval(checkpoint.scan),
    confirmedThrough: checkpoint.confirmedThrough,
    snapshotToken: checkpoint.snapshotToken,
    snapshotGeneration: checkpoint.snapshotGeneration,
    snapshotRange: copyInterval(checkpoint.snapshotRange),
    pending: checkpoint.pending.map(copyInterval),
    retiredSnapshots: checkpoint.retiredSnapshots.map((retired) => ({
      token: retired.token,
      generation: retired.generation,
      reason: retired.reason,
      pending: retired.pending.map(copyInterval),
    })),
  };
}

function validateInterval(interval: Interval, label: string): void {
  if (
    typeof interval !== "object" ||
    interval === null ||
    typeof interval.from !== "bigint" ||
    typeof interval.to !== "bigint"
  ) {
    throw new CheckpointError(
      "MALFORMED_INTERVAL",
      `${label} must contain bigint from/to`,
    );
  }
  assertInt64(interval.from, "CHECKPOINT_TIME_OUT_OF_DOMAIN", `${label}.from`);
  assertInt64(interval.to, "CHECKPOINT_TIME_OUT_OF_DOMAIN", `${label}.to`);
  if (interval.from > interval.to) {
    throw new CheckpointError(
      "REVERSED_INTERVAL",
      `${label}.from must not exceed ${label}.to`,
    );
  }
}

function validatePendingCoverage(
  pending: readonly Interval[],
  start: bigint,
  end: bigint,
  snapshotRange: Interval,
): void {
  if (start > end) {
    if (pending.length !== 0) {
      throw new CheckpointError(
        "UNEXPECTED_PENDING",
        "pending must be empty when the scan is complete",
      );
    }
    return;
  }
  if (pending.length === 0) {
    throw new CheckpointError(
      "MISSING_PENDING",
      "pending intervals do not cover the unfinished scan range",
    );
  }
  let expected = start;
  for (let index = 0; index < pending.length; index += 1) {
    const interval = pending[index];
    validateInterval(interval, `pending[${index}]`);
    if (interval.from !== expected) {
      throw new CheckpointError(
        "PENDING_GAP_OR_OVERLAP",
        "pending intervals must be ordered, disjoint and contiguous",
        {
          index,
          expected: expected.toString(),
          actual: interval.from.toString(),
        },
      );
    }
    if (
      interval.from < snapshotRange.from ||
      interval.to > snapshotRange.to
    ) {
      throw new CheckpointError(
        "PENDING_OUTSIDE_SNAPSHOT",
        "pending interval lies outside the acquired snapshot range",
      );
    }
    expected = interval.to + 1n;
  }
  if (expected - 1n !== end) {
    throw new CheckpointError(
      "PENDING_DOES_NOT_REACH_END",
      "pending intervals do not cover the whole unfinished scan range",
      { expectedEnd: (expected - 1n).toString(), actualEnd: end.toString() },
    );
  }
}

function validateCheckpoint(
  checkpoint: Checkpoint,
  options: {
    readonly k: number;
    readonly streamId: string;
    readonly providedFrom: bigint | undefined;
    readonly providedTo: bigint | undefined;
  },
): void {
  if (checkpoint.version !== 1) {
    throw new CheckpointError(
      "UNSUPPORTED_VERSION",
      `unsupported checkpoint version: ${String(checkpoint.version)}`,
    );
  }
  if (checkpoint.k !== options.k) {
    throw new CheckpointError(
      "K_MISMATCH",
      `checkpoint page size ${checkpoint.k} does not match configured ${options.k}`,
    );
  }
  if (checkpoint.streamId !== options.streamId) {
    throw new CheckpointError(
      "STREAM_MISMATCH",
      `checkpoint stream ${checkpoint.streamId} does not match ${options.streamId}`,
    );
  }
  validateInterval(checkpoint.scan, "scan");
  if (
    options.providedFrom !== undefined &&
    checkpoint.scan.from !== options.providedFrom
  ) {
    throw new CheckpointError(
      "SCAN_FROM_MISMATCH",
      "checkpoint scan.from differs from the configured from",
    );
  }
  if (
    options.providedTo !== undefined &&
    checkpoint.scan.to !== options.providedTo
  ) {
    throw new CheckpointError(
      "SCAN_TO_MISMATCH",
      "checkpoint scan.to differs from the configured to",
    );
  }
  if (
    typeof checkpoint.snapshotToken !== "string" ||
    checkpoint.snapshotToken.length === 0
  ) {
    throw new CheckpointError(
      "MALFORMED_SNAPSHOT_TOKEN",
      "checkpoint snapshotToken must be a non-empty string",
    );
  }
  if (
    !Number.isSafeInteger(checkpoint.snapshotGeneration) ||
    checkpoint.snapshotGeneration < 1
  ) {
    throw new CheckpointError(
      "MALFORMED_GENERATION",
      "checkpoint snapshotGeneration must be a positive integer",
    );
  }
  validateInterval(checkpoint.snapshotRange, "snapshotRange");
  if (checkpoint.confirmedThrough !== null) {
    assertInt64(
      checkpoint.confirmedThrough,
      "CHECKPOINT_TIME_OUT_OF_DOMAIN",
      "confirmedThrough",
    );
    if (
      checkpoint.confirmedThrough < checkpoint.scan.from ||
      checkpoint.confirmedThrough > checkpoint.scan.to
    ) {
      throw new CheckpointError(
        "WATERMARK_OUT_OF_SCAN",
        "confirmedThrough must lie inside the configured scan range",
      );
    }
  }
  const start =
    checkpoint.confirmedThrough === null
      ? checkpoint.scan.from
      : checkpoint.confirmedThrough + 1n;
  validatePendingCoverage(
    checkpoint.pending,
    start,
    checkpoint.scan.to,
    checkpoint.snapshotRange,
  );
  for (let index = 0; index < checkpoint.retiredSnapshots.length; index += 1) {
    const retired = checkpoint.retiredSnapshots[index];
    if (
      typeof retired.token !== "string" ||
      retired.token.length === 0 ||
      typeof retired.reason !== "string" ||
      !Number.isSafeInteger(retired.generation) ||
      retired.generation < 1
    ) {
      throw new CheckpointError(
        "MALFORMED_RETIRED_SNAPSHOT",
        `retiredSnapshots[${index}] is malformed`,
      );
    }
    for (let pendingIndex = 0; pendingIndex < retired.pending.length; pendingIndex += 1) {
      validateInterval(
        retired.pending[pendingIndex],
        `retiredSnapshots[${index}].pending[${pendingIndex}]`,
      );
    }
  }
}

function normalizeRecord(
  raw: RemoteRecord,
  timeCode: string,
): CollectedRecord {
  if (typeof raw !== "object" || raw === null) {
    throw new RemoteContractError(
      "MALFORMED_RECORD",
      "record must be an object",
    );
  }
  if (typeof raw.id !== "string") {
    throw new RemoteContractError(
      "MALFORMED_RECORD_ID",
      "record.id must be a string",
    );
  }
  const time = normalizeTime(raw.time, timeCode, `record(${raw.id}).time`);
  return { id: raw.id, time, content: raw.content };
}

function normalizeRangePage(
  page: RangePage,
  from: bigint,
  to: bigint,
  k: number,
): NormalizedRangePage {
  if (typeof page !== "object" || page === null) {
    throw new RemoteContractError(
      "MALFORMED_RESPONSE",
      "range page must be an object",
    );
  }
  if (!Array.isArray(page.records)) {
    throw new RemoteContractError(
      "MALFORMED_RESPONSE",
      "range page records must be an array",
    );
  }
  const total = parseCount(page.total);
  if (page.records.length > k) {
    throw new RemoteContractError(
      "RECORD_COUNT_EXCEEDS_K",
      "range page contains more records than K",
      {
        from: from.toString(),
        to: to.toString(),
        k,
        count: page.records.length,
        total: total.toString(),
      },
    );
  }
  if (BigInt(page.records.length) > total) {
    throw new RemoteContractError(
      "RECORD_COUNT_EXCEEDS_TOTAL",
      "range page contains more records than total",
      {
        from: from.toString(),
        to: to.toString(),
        count: page.records.length,
        total: total.toString(),
      },
    );
  }
  if (total <= BigInt(k) && page.records.length !== Number(total)) {
    throw new RemoteContractError(
      "COUNT_TOTAL_MISMATCH",
      "total <= K requires the page to contain exactly total records",
      {
        from: from.toString(),
        to: to.toString(),
        k,
        count: page.records.length,
        total: total.toString(),
      },
    );
  }
  const records: CollectedRecord[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < page.records.length; index += 1) {
    const record = normalizeRecord(
      page.records[index],
      "RECORD_TIME_INVALID",
    );
    if (record.time < from || record.time > to) {
      throw new RemoteContractError(
        "RECORD_TIME_OUT_OF_RANGE",
        "range page returned a record outside the queried interval",
        {
          from: from.toString(),
          to: to.toString(),
          recordTime: record.time.toString(),
          id: record.id,
        },
      );
    }
    if (ids.has(record.id)) {
      throw new RemoteContractError(
        "DUPLICATE_ID",
        "range page contains a duplicate record id",
        { id: record.id },
      );
    }
    ids.add(record.id);
    records.push(record);
  }
  return { total, records };
}

function normalizeSeekPage(
  page: SeekPage,
  time: bigint,
  afterId: string | null,
  k: number,
): NormalizedSeekPage {
  if (typeof page !== "object" || page === null) {
    throw new RemoteContractError(
      "MALFORMED_RESPONSE",
      "seek page must be an object",
    );
  }
  if (!Array.isArray(page.records)) {
    throw new RemoteContractError(
      "MALFORMED_RESPONSE",
      "seek page records must be an array",
    );
  }
  if (page.records.length > k) {
    throw new RemoteContractError(
      "RECORD_COUNT_EXCEEDS_K",
      "seek page contains more records than K",
      { time: time.toString(), k, count: page.records.length },
    );
  }
  let hasMore: boolean | undefined;
  if (page.hasMore !== undefined) {
    if (typeof page.hasMore !== "boolean") {
      throw new RemoteContractError(
        "MALFORMED_RESPONSE",
        "seek page hasMore must be boolean",
      );
    }
    hasMore = page.hasMore;
  }
  if (hasMore === true && page.records.length === 0) {
    throw new RemoteContractError(
      "SEEK_HAS_MORE_EMPTY_PAGE",
      "seek page cannot be empty while hasMore is true",
      { time: time.toString(), afterId },
    );
  }
  const records: CollectedRecord[] = [];
  let previousId: string | null = afterId;
  for (let index = 0; index < page.records.length; index += 1) {
    const record = normalizeRecord(
      page.records[index],
      "SEEK_TIME_INVALID",
    );
    if (record.time !== time) {
      throw new RemoteContractError(
        "SEEK_TIME_MISMATCH",
        "seek page returned a record for another timestamp",
        {
          expectedTime: time.toString(),
          recordTime: record.time.toString(),
          id: record.id,
        },
      );
    }
    if (previousId !== null && compareIdBytes(record.id, previousId) <= 0) {
      const code =
        index === 0 && afterId !== null
          ? "SEEK_CURSOR_NOT_EXCLUSIVE"
          : "SEEK_NOT_STRICTLY_INCREASING";
      throw new RemoteContractError(
        code,
        "seek page ids must be strictly greater than the cursor and strictly increasing",
        {
          time: time.toString(),
          cursor: previousId,
          id: record.id,
        },
      );
    }
    previousId = record.id;
    records.push(record);
  }
  return { records, hasMore };
}

function freezeRecords(records: readonly CollectedRecord[]): readonly CollectedRecord[] {
  const frozen = records.map((record) =>
    Object.freeze({
      id: record.id,
      time: record.time,
      content: record.content,
    }),
  );
  return Object.freeze(frozen);
}

class DeliveredBucketImpl implements BucketDelivery {
  readonly kind = "bucket" as const;
  readonly bucketId: string;
  readonly snapshotToken: string;
  readonly snapshotGeneration: number;
  readonly interval: Interval;
  readonly records: readonly CollectedRecord[];
  attempt: number;
  isRedelivery: boolean;
  private readonly session: CollectorSession;

  constructor(
    session: CollectorSession,
    fields: {
      readonly bucketId: string;
      readonly snapshotToken: string;
      readonly snapshotGeneration: number;
      readonly interval: Interval;
      readonly records: readonly CollectedRecord[];
      readonly attempt: number;
      readonly isRedelivery: boolean;
    },
  ) {
    this.session = session;
    this.bucketId = fields.bucketId;
    this.snapshotToken = fields.snapshotToken;
    this.snapshotGeneration = fields.snapshotGeneration;
    this.interval = copyInterval(fields.interval);
    this.records = fields.records;
    this.attempt = fields.attempt;
    this.isRedelivery = fields.isRedelivery;
  }

  confirm(): Promise<ConfirmResult> {
    return this.session.confirmBucket(this);
  }
}

/**
 * One collection round under one fixed snapshot token. The caller pulls one
 * bucket at a time; a bucket is redelivered until it is explicitly confirmed.
 */
export class CollectorSession {
  readonly snapshotToken: string;
  readonly snapshotGeneration: number;

  private readonly remote: SnapshotRemote;
  private readonly store: CheckpointStore;
  private readonly k: number;
  private readonly signal: AbortSignal | undefined;
  private readonly abortListener: (() => void) | undefined;
  private cp: Checkpoint;
  private sessionState: SessionState;
  private currentBucket: DeliveredBucketImpl | null = null;
  private cancelRequested = false;
  private cancelReason = "cancelled";
  private confirmReservation: DeliveredBucketImpl | null = null;
  private confirmPromise: Promise<ConfirmResult> | null = null;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    remote: SnapshotRemote,
    store: CheckpointStore,
    k: number,
    checkpoint: Checkpoint,
    signal: AbortSignal | undefined,
  ) {
    this.remote = remote;
    this.store = store;
    this.k = k;
    this.cp = copyCheckpoint(checkpoint);
    this.snapshotToken = checkpoint.snapshotToken;
    this.snapshotGeneration = checkpoint.snapshotGeneration;
    this.signal = signal;
    this.sessionState =
      checkpoint.confirmedThrough === checkpoint.scan.to ? "done" : "active";
    if (signal !== undefined) {
      if (signal.aborted) {
        this.cancelRequested = true;
        this.cancelReason = "aborted";
      } else {
        this.abortListener = () => {
          this.cancel("aborted");
        };
        signal.addEventListener("abort", this.abortListener, { once: true });
      }
    }
  }

  get state(): SessionState {
    return this.sessionState;
  }

  get currentCheckpoint(): Checkpoint {
    return copyCheckpoint(this.cp);
  }

  next(): Promise<NextResult> {
    return this.enqueue(() => this.doNext());
  }

  /**
   * Cancellation is an explicit, synchronous decision. If a confirmation has
   * already been reserved (confirm was invoked first), that confirmation is
   * allowed to finish and this call reports "after-confirm".
   */
  cancel(reason = "cancelled"): CancelOutcome {
    if (this.sessionState === "done" || this.sessionState === "expired") {
      this.removeAbortListener();
      return "finished";
    }
    if (this.sessionState === "cancelled") {
      return "already-cancelled";
    }
    if (this.confirmReservation !== null) {
      this.cancelRequested = true;
      this.cancelReason = reason;
      this.sessionState = "cancelled";
      this.removeAbortListener();
      return "after-confirm";
    }
    if (this.cancelRequested) {
      return "already-cancelled";
    }
    this.cancelRequested = true;
    this.cancelReason = reason;
    this.sessionState = "cancelled";
    this.removeAbortListener();
    return "cancelled";
  }

  confirmBucket(bucket: DeliveredBucketImpl): Promise<ConfirmResult> {
    if (this.cancelRequested || this.signal?.aborted) {
      return Promise.resolve({
        confirmed: false,
        bucketId: bucket.bucketId,
        reason: "cancelled",
      });
    }
    if (this.currentBucket !== bucket) {
      return Promise.resolve({
        confirmed: false,
        bucketId: bucket.bucketId,
        reason: "stale",
      });
    }
    if (this.confirmReservation === bucket && this.confirmPromise !== null) {
      return this.confirmPromise;
    }
    this.confirmReservation = bucket;
    const promise = this.enqueue(() => this.doConfirm(bucket));
    this.confirmPromise = promise;
    return promise;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async doConfirm(
    bucket: DeliveredBucketImpl,
  ): Promise<ConfirmResult> {
    if (this.currentBucket !== bucket) {
      this.clearConfirmReservation();
      return {
        confirmed: false,
        bucketId: bucket.bucketId,
        reason: "stale",
      };
    }
    const expectedStart =
      this.cp.confirmedThrough === null
        ? this.cp.scan.from
        : this.cp.confirmedThrough + 1n;
    if (
      bucket.interval.from !== expectedStart ||
      this.cp.pending.length === 0 ||
      this.cp.pending[0].from !== bucket.interval.from ||
      this.cp.pending[0].to !== bucket.interval.to
    ) {
      this.clearConfirmReservation();
      return {
        confirmed: false,
        bucketId: bucket.bucketId,
        reason: "stale",
      };
    }
    const candidate: Checkpoint = {
      ...copyCheckpoint(this.cp),
      confirmedThrough: bucket.interval.to,
      pending: this.cp.pending.slice(1).map(copyInterval),
    };
    try {
      await this.store.saveCheckpoint(candidate);
    } catch (error) {
      this.clearConfirmReservation();
      return {
        confirmed: false,
        bucketId: bucket.bucketId,
        reason: "storage-failed",
        error,
      };
    }
    this.cp = candidate;
    this.currentBucket = null;
    this.clearConfirmReservation();
    if (candidate.confirmedThrough === candidate.scan.to) {
      this.sessionState = "done";
      this.removeAbortListener();
    }
    return {
      confirmed: true,
      bucketId: bucket.bucketId,
      watermark: bucket.interval.to,
    };
  }

  private clearConfirmReservation(): void {
    this.confirmReservation = null;
    this.confirmPromise = null;
  }

  private async doNext(): Promise<NextResult> {
    if (this.cancelRequested || this.signal?.aborted) {
      this.cancelRequested = true;
      this.sessionState = "cancelled";
      this.removeAbortListener();
      return this.cancelledResult();
    }
    if (this.sessionState === "done") {
      return {
        kind: "done",
        confirmedThrough: this.cp.scan.to,
      };
    }
    if (this.sessionState === "expired") {
      return this.expiredResult();
    }
    if (this.sessionState === "cancelled") {
      return this.cancelledResult();
    }
    if (this.currentBucket !== null) {
      const bucket = this.currentBucket;
      bucket.attempt += 1;
      bucket.isRedelivery = true;
      await this.store.appendEvidence(this.evidenceFor(bucket));
      if (this.cancelRequested || this.signal?.aborted) {
        this.cancelRequested = true;
        this.sessionState = "cancelled";
        this.removeAbortListener();
        return this.cancelledResult();
      }
      return { kind: "bucket", bucket };
    }
    if (this.cp.pending.length === 0) {
      if (this.cp.confirmedThrough === this.cp.scan.to) {
        this.sessionState = "done";
        return { kind: "done", confirmedThrough: this.cp.scan.to };
      }
      throw new CheckpointError(
        "MISSING_PENDING",
        "checkpoint has no pending intervals but is not complete",
      );
    }

    const queue = this.cp.pending.map(copyInterval);
    while (queue.length > 0) {
      if (this.cancelRequested || this.signal?.aborted) {
        this.cancelRequested = true;
        this.sessionState = "cancelled";
        this.removeAbortListener();
        return this.cancelledResult();
      }
      const head = queue[0];
      let page: RangePage;
      try {
        page = await this.remote.queryRange(
          head.from,
          head.to,
          this.snapshotToken,
        );
      } catch (error) {
        if (this.cancelRequested || this.signal?.aborted) {
          this.cancelRequested = true;
          this.sessionState = "cancelled";
          this.removeAbortListener();
          return this.cancelledResult();
        }
        if (isSnapshotExpired(error)) {
          this.sessionState = "expired";
          this.removeAbortListener();
          return this.expiredResult();
        }
        throw error;
      }
      if (this.cancelRequested || this.signal?.aborted) {
        this.cancelRequested = true;
        this.sessionState = "cancelled";
        this.removeAbortListener();
        return this.cancelledResult();
      }
      const normalized = normalizeRangePage(
        page,
        head.from,
        head.to,
        this.k,
      );
      if (normalized.total <= BigInt(this.k)) {
        return this.deliverBucket(head, normalized.records, queue);
      }
      if (head.from === head.to) {
        let records: readonly CollectedRecord[];
        try {
          records = await this.collectPoint(head.from, normalized.total);
        } catch (error) {
          if (this.cancelRequested || this.signal?.aborted) {
            this.cancelRequested = true;
            this.sessionState = "cancelled";
            this.removeAbortListener();
            return this.cancelledResult();
          }
          if (isSnapshotExpired(error)) {
            this.sessionState = "expired";
            this.removeAbortListener();
            return this.expiredResult();
          }
          throw error;
        }
        if (this.cancelRequested || this.signal?.aborted) {
          this.cancelRequested = true;
          this.sessionState = "cancelled";
          this.removeAbortListener();
          return this.cancelledResult();
        }
        return this.deliverBucket(head, records, queue);
      }
      const [left, right] = splitTimeInterval(head.from, head.to);
      queue.splice(0, 1, copyInterval(left), copyInterval(right));
    }
    throw new CheckpointError(
      "EMPTY_PENDING_QUEUE",
      "pending queue became empty before a bucket was produced",
    );
  }

  private async collectPoint(
    time: bigint,
    total: bigint,
  ): Promise<readonly CollectedRecord[]> {
    const records: CollectedRecord[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page: SeekPage = await this.remote.seekById(
        time,
        cursor,
        this.snapshotToken,
      );
      if (this.cancelRequested || this.signal?.aborted) {
        return records;
      }
      const normalized = normalizeSeekPage(page, time, cursor, this.k);
      if (normalized.records.length === 0) {
        break;
      }
      for (const record of normalized.records) {
        records.push(record);
      }
      cursor = normalized.records[normalized.records.length - 1].id;
      if (normalized.hasMore === false) {
        break;
      }
    }
    if (BigInt(records.length) !== total) {
      throw new RemoteContractError(
        "SEEK_TOTAL_MISMATCH",
        "seek enumeration did not return exactly the range total",
        {
          time: time.toString(),
          total: total.toString(),
          collected: records.length,
        },
      );
    }
    return records;
  }

  private async deliverBucket(
    interval: Interval,
    records: readonly CollectedRecord[],
    pending: readonly Interval[],
  ): Promise<NextResult> {
    if (this.cancelRequested || this.signal?.aborted) {
      this.cancelRequested = true;
      this.sessionState = "cancelled";
      this.removeAbortListener();
      return this.cancelledResult();
    }
    const sorted = records.slice().sort((left, right) => {
      if (left.time !== right.time) {
        return left.time < right.time ? -1 : 1;
      }
      return compareIdBytes(left.id, right.id);
    });
    const seen = new Set<string>();
    for (const record of sorted) {
      if (seen.has(record.id)) {
        throw new RemoteContractError(
          "DUPLICATE_ID",
          "bucket contains a duplicate record id",
          { id: record.id, from: interval.from.toString(), to: interval.to.toString() },
        );
      }
      seen.add(record.id);
    }
    const frozen = freezeRecords(sorted);
    const pendingAfter = pending.map(copyInterval);
    if (
      pendingAfter.length === 0 ||
      pendingAfter[0].from !== interval.from ||
      pendingAfter[0].to !== interval.to
    ) {
      throw new CheckpointError(
        "QUEUE_DESYNC",
        "current interval is not at the head of the pending queue",
      );
    }
    const candidate: Checkpoint = {
      ...copyCheckpoint(this.cp),
      pending: pendingAfter,
    };
    await this.store.saveCheckpoint(candidate);
    this.cp = candidate;
    const bucketId = `${this.snapshotToken}|${interval.from.toString()}|${interval.to.toString()}`;
    const bucket = new DeliveredBucketImpl(this, {
      bucketId,
      snapshotToken: this.snapshotToken,
      snapshotGeneration: this.snapshotGeneration,
      interval,
      records: frozen,
      attempt: 1,
      isRedelivery: false,
    });
    await this.store.appendEvidence(this.evidenceFor(bucket));
    if (this.cancelRequested || this.signal?.aborted) {
      this.cancelRequested = true;
      this.sessionState = "cancelled";
      this.removeAbortListener();
      return this.cancelledResult();
    }
    this.currentBucket = bucket;
    return { kind: "bucket", bucket };
  }

  private evidenceFor(bucket: DeliveredBucketImpl): DeliveryEvidence {
    return {
      deliveryId: `${bucket.bucketId}#${bucket.attempt}`,
      bucketId: bucket.bucketId,
      snapshotToken: bucket.snapshotToken,
      snapshotGeneration: bucket.snapshotGeneration,
      interval: copyInterval(bucket.interval),
      attempt: bucket.attempt,
      records: bucket.records,
    };
  }

  private expiredResult(): NextResult {
    return {
      kind: "expired",
      snapshotToken: this.snapshotToken,
      checkpoint: copyCheckpoint(this.cp),
    };
  }

  private cancelledResult(): NextResult {
    return {
      kind: "cancelled",
      reason: this.cancelReason,
      checkpoint: copyCheckpoint(this.cp),
    };
  }

  private removeAbortListener(): void {
    if (this.signal !== undefined && this.abortListener !== undefined) {
      this.signal.removeEventListener("abort", this.abortListener);
    }
  }
}

function validateK(k: number): void {
  if (!Number.isSafeInteger(k) || k <= 0) {
    throw new RangeError("k must be a positive safe integer");
  }
}

function validateSnapshotToken(snapshot: Snapshot): string {
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    typeof snapshot.token !== "string" ||
    snapshot.token.length === 0
  ) {
    throw new RemoteContractError(
      "MALFORMED_SNAPSHOT",
      "acquireSnapshot must return a non-empty string token",
    );
  }
  return snapshot.token;
}

/**
 * Importable collector. `start` either resumes a checkpoint (validating its
 * unfinished intervals) or acquires an initial snapshot.
 */
export class IncrementalTimeCollector {
  private readonly remote: SnapshotRemote;
  private readonly k: number;
  private readonly store: CheckpointStore;
  private readonly streamId: string;
  private readonly providedFrom: bigint | undefined;
  private readonly providedTo: bigint | undefined;
  private readonly signal: AbortSignal | undefined;

  constructor(options: CollectorOptions) {
    if (typeof options !== "object" || options === null) {
      throw new TypeError("collector options are required");
    }
    validateK(options.k);
    const from =
      options.from === undefined
        ? undefined
        : normalizeTime(options.from, "TIME_OUT_OF_DOMAIN", "from");
    const to =
      options.to === undefined
        ? undefined
        : normalizeTime(options.to, "TIME_OUT_OF_DOMAIN", "to");
    if (
      from !== undefined &&
      to !== undefined &&
      from > to
    ) {
      throw new RangeError("from must not exceed to");
    }
    this.remote = options.remote;
    this.k = options.k;
    this.store = options.store;
    this.streamId = options.streamId ?? "default";
    if (this.streamId.length === 0) {
      throw new RangeError("streamId must be a non-empty string");
    }
    this.providedFrom = from;
    this.providedTo = to;
    this.signal = options.signal;
  }

  async start(): Promise<CollectorSession> {
    const stored = await this.store.loadCheckpoint();
    if (stored !== null) {
      validateCheckpoint(stored, {
        k: this.k,
        streamId: this.streamId,
        providedFrom: this.providedFrom,
        providedTo: this.providedTo,
      });
      let checkpoint = copyCheckpoint(stored);
      if (checkpoint.confirmedThrough === checkpoint.scan.to) {
        return new CollectorSession(
          this.remote,
          this.store,
          this.k,
          checkpoint,
          this.signal,
        );
      }
      const start =
        checkpoint.confirmedThrough === null
          ? checkpoint.scan.from
          : checkpoint.confirmedThrough + 1n;
      try {
        await this.remote.queryRange(
          start,
          start,
          checkpoint.snapshotToken,
        );
      } catch (error) {
        if (!isSnapshotExpired(error)) {
          throw error;
        }
        const retired: RetiredSnapshot = {
          token: checkpoint.snapshotToken,
          generation: checkpoint.snapshotGeneration,
          reason: "expired-on-resume",
          pending: checkpoint.pending.map(copyInterval),
        };
        const request: SnapshotRequest = {
          from: start,
          to: checkpoint.scan.to,
        };
        const snapshot = await this.remote.acquireSnapshot(request);
        const token = validateSnapshotToken(snapshot);
        const usedTokens = new Set([
          checkpoint.snapshotToken,
          ...checkpoint.retiredSnapshots.map((retired) => retired.token),
        ]);
        if (usedTokens.has(token)) {
          throw new RemoteContractError(
            "SNAPSHOT_TOKEN_REUSED",
            "acquireSnapshot returned a token from an earlier snapshot generation",
            { token },
          );
        }
        checkpoint = {
          ...checkpoint,
          snapshotToken: token,
          snapshotGeneration: checkpoint.snapshotGeneration + 1,
          snapshotRange: request,
          pending: [copyInterval(request)],
          retiredSnapshots: [...checkpoint.retiredSnapshots, retired],
        };
        await this.store.saveCheckpoint(checkpoint);
      }
      return new CollectorSession(
        this.remote,
        this.store,
        this.k,
        checkpoint,
        this.signal,
      );
    }

    const from = this.providedFrom ?? INT64_MIN;
    const to = this.providedTo ?? INT64_MAX;
    if (from > to) {
      throw new RangeError("from must not exceed to");
    }
    assertInt64(from, "TIME_OUT_OF_DOMAIN", "from");
    assertInt64(to, "TIME_OUT_OF_DOMAIN", "to");
    const request: SnapshotRequest = { from, to };
    const snapshot = await this.remote.acquireSnapshot(request);
    const token = validateSnapshotToken(snapshot);
    const checkpoint: Checkpoint = {
      version: 1,
      streamId: this.streamId,
      k: this.k,
      scan: request,
      confirmedThrough: null,
      snapshotToken: token,
      snapshotGeneration: 1,
      snapshotRange: request,
      pending: [copyInterval(request)],
      retiredSnapshots: [],
    };
    await this.store.saveCheckpoint(checkpoint);
    return new CollectorSession(
      this.remote,
      this.store,
      this.k,
      checkpoint,
      this.signal,
    );
  }
}
