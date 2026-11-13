/**
 * Sequence-aware JetStream archive coordinator.
 *
 * The archiver deliberately has no NATS dependency. It accepts the delivery
 * shape exposed by the TypeScript JetStream clients (and a small, explicit
 * normalized shape) and drives an ordered archive sink.
 */

export type HoleReason = "deleted" | "retention" | "not-found" | "unknown";

export interface SequenceRange {
  /** Inclusive first stream sequence. */
  start: number;
  /** Inclusive last stream sequence. */
  end: number;
}

export type SequenceSelection =
  | number
  | SequenceRange
  | readonly (number | SequenceRange)[];

export interface JetStreamDelivery<T = unknown> {
  /** Stream sequence (NATS.js `msg.seq`). */
  seq?: number | string | bigint;
  streamSeq?: number | string | bigint;
  streamSequence?: number | string | bigint;
  stream_seq?: number | string | bigint;
  /** Consumer/delivery sequence, when the source exposes it. */
  consumerSeq?: number | string | bigint;
  consumerSequence?: number | string | bigint;
  consumer_seq?: number | string | bigint;
  deliverySeq?: number | string | bigint;
  deliverySequence?: number | string | bigint;
  delivery_seq?: number | string | bigint;
  sequence?: {
    stream?: number | string | bigint;
    consumer?: number | string | bigint;
  };
  data?: T;
  payload?: T;
  subject?: string;
  headers?: Readonly<Record<string, string | string[]>>;
  redelivery?: boolean;
  redelivered?: boolean;
  redeliveryCount?: number;
  redeliveredCount?: number;
  timestamp?: number | string | Date;
  time?: number | string | Date;
  /** Subset of the metadata returned by NATS.js v3. */
  info?: {
    streamSeq?: number | string | bigint;
    streamSequence?: number | string | bigint;
    deliverySeq?: number | string | bigint;
    deliverySequence?: number | string | bigint;
    redeliveryCount?: number;
    timestamp?: number | string;
  };
  /** Subset of the metadata returned by NATS.js v2. */
  meta?: {
    sequence?: {
      stream?: number | string | bigint;
      consumer?: number | string | bigint;
    };
  };
  metadata?: {
    sequence?: {
      stream?: number | string | bigint;
      consumer?: number | string | bigint;
    };
  };
  /** Backfill records are not consumer deliveries and do not get a consumer seq. */
  source?: "live" | "backfill";
}

export interface ArchiveRecord<T = unknown> {
  /** Primary stream sequence. */
  streamSeq: number;
  /** Alias useful when adapting to code that uses the longer NATS name. */
  streamSequence: number;
  consumerSeq?: number;
  consumerSequence?: number;
  data: T | undefined;
  subject?: string;
  headers?: Readonly<Record<string, string | string[]>>;
  timestamp: number;
  redelivery: boolean;
  redeliveryCount: number;
  source: "live" | "backfill";
}

export interface BackfillRequest {
  id: number;
  /** Inclusive missing stream-sequence interval. */
  start: number;
  end: number;
  range: SequenceRange;
  streamRange: SequenceRange;
  reason: "stream-gap";
  requestedAt: number;
}

export interface PermanentHole {
  id: number;
  start: number;
  end: number;
  range: SequenceRange;
  streamRange: SequenceRange;
  /** Every sequence in this contiguous hole. */
  sequences: number[];
  reason: HoleReason;
  detectedAt: number;
  requestId?: number;
}

export interface ArchiveCommit {
  /** Highest stream sequence for which no work remains. */
  streamSeq: number;
  streamSequence: number;
  /**
   * Highest consumer sequence covered by this checkpoint. Consumer sequences
   * are independent of stream sequences and may lag when the gap was filled
   * from a direct backfill rather than a consumer delivery.
   */
  consumerSeq: number;
  consumerSequence: number;
  /** Number of ordered application messages published by this drain. */
  published: number;
  /** Permanent holes crossed by this checkpoint. */
  holes: PermanentHole[];
}

export interface BackfillResult<T = unknown> {
  requestId?: number;
  /** Defaults to the active request's range. */
  range?: SequenceRange;
  messages?: readonly JetStreamDelivery<T>[];
  /** Alias for messages. */
  records?: readonly JetStreamDelivery<T>[];
  /**
   * Sequences known to be permanently absent. `complete: true` also turns
   * every sequence in `range` that did not arrive into a permanent hole.
   */
  holes?: SequenceSelection;
  /** Aliases for holes, useful with direct-get 404 responses. */
  deleted?: SequenceSelection;
  missing?: SequenceSelection;
  complete?: boolean;
  holeReason?: HoleReason;
}

export interface IngestResult {
  accepted: boolean;
  duplicate: boolean;
  buffered: boolean;
  published: number;
  gap?: SequenceRange;
}

export interface BackfillOutcome {
  requestId?: number;
  range?: SequenceRange;
  accepted: number;
  duplicates: number;
  holesRecorded: number;
  published: number;
  resolved: boolean;
}

export interface FlowControlInfo {
  count: number;
  lastStreamSequence?: number;
  lastAt: number;
}

export interface HeartbeatInfo {
  count: number;
  lastAt: number;
}

export interface JetStreamControl {
  type: "flow-control" | "heartbeat";
  streamSequence?: number | string | bigint;
  at?: number | string | Date;
}

export interface ArchiveSnapshot {
  stream: {
    committedSeq: number;
    nextSeq: number;
    highestObservedSeq: number;
    pending: number;
    commitPaused: boolean;
    activeGap?: SequenceRange;
  };
  consumer: {
    committedSeq: number;
    highestObservedSeq: number;
    nextAssignedSeq: number;
    redeliveries: number;
    duplicates: number;
    regressions: number;
  };
  backfill: {
    activeRequest?: BackfillRequest;
    requests: BackfillRequest[];
  };
  permanentHoles: PermanentHole[];
  flowControl: FlowControlInfo;
  heartbeat: HeartbeatInfo;
}

export interface JetStreamArchiverOptions<T = unknown> {
  /**
   * First stream sequence expected by the archive. Defaults to 1. When
   * resuming from a checkpoint, pass the sequence after the last committed
   * one (or persist `snapshot().stream.nextSeq`).
   */
  startStreamSeq?: number;
  /** Last consumer sequence already accounted for. Defaults to 0. */
  startConsumerSeq?: number;
  publish?: (record: ArchiveRecord<T>) => void;
  /** Called exactly once for each newly detected, not-yet-requested gap. */
  requestBackfill?: (request: BackfillRequest) => void;
  onCommit?: (commit: ArchiveCommit) => void;
  onPermanentHole?: (hole: PermanentHole) => void;
  onFlowControl?: (info: FlowControlInfo) => void;
  onHeartbeat?: (info: HeartbeatInfo) => void;
  /** Injectable clock, mainly useful in tests. */
  now?: () => number;
}

export type JetStreamArchiverErrorCode =
  | "INVALID_STREAM_SEQUENCE"
  | "INVALID_CONSUMER_SEQUENCE"
  | "INVALID_RANGE"
  | "INVALID_CONTROL"
  | "BACKFILL_NOT_ACTIVE"
  | "BACKFILL_REQUEST_MISMATCH";

export class JetStreamArchiverError extends Error {
  readonly code: JetStreamArchiverErrorCode;

  constructor(code: JetStreamArchiverErrorCode, message: string) {
    super(message);
    this.name = "JetStreamArchiverError";
    this.code = code;
  }
}

interface PendingRecord<T> {
  record: ArchiveRecord<T>;
}

interface NormalizedDelivery<T> {
  streamSeq: number;
  consumerSeq?: number;
  data: T | undefined;
  subject?: string;
  headers?: Readonly<Record<string, string | string[]>>;
  timestamp: number;
  redelivery: boolean;
  redeliveryCount: number;
  source: "live" | "backfill";
}

function sequenceNumber(
  value: number | string | bigint | undefined,
  code: JetStreamArchiverErrorCode,
  label: string,
  minimum: number,
): number | undefined {
  if (value === undefined) return undefined;

  let parsed: number;
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    if (!Number.isSafeInteger(asNumber)) {
      throw new JetStreamArchiverError(code, `${label} is outside the safe integer range`);
    }
    parsed = asNumber;
  } else if (typeof value === "string") {
    if (!/^\d+$/.test(value)) {
      throw new JetStreamArchiverError(code, `${label} must be a non-negative integer`);
    }
    parsed = Number(value);
  } else {
    parsed = value;
  }

  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new JetStreamArchiverError(
      code,
      `${label} must be a safe integer >= ${minimum}`,
    );
  }
  return parsed;
}

function normalizedRange(range: SequenceRange, label: string): SequenceRange {
  const start = sequenceNumber(
    range?.start,
    "INVALID_RANGE",
    `${label}.start`,
    1,
  );
  const end = sequenceNumber(range?.end, "INVALID_RANGE", `${label}.end`, 1);
  if (start === undefined || end === undefined || end < start) {
    throw new JetStreamArchiverError(
      "INVALID_RANGE",
      `${label} must be an inclusive, increasing stream-sequence range`,
    );
  }
  return { start, end };
}

function timestampNumber(value: number | string | Date | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (value instanceof Date) {
    const parsed = value.getTime();
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return Number.isFinite(value) ? value : fallback;
}

function firstSequence(
  values: readonly (number | string | bigint | undefined)[],
): number | string | bigint | undefined {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function containsRange(outer: SequenceRange, inner: SequenceRange): boolean {
  return outer.start <= inner.start && outer.end >= inner.end;
}

function mergeRanges(ranges: readonly SequenceRange[]): SequenceRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((left, right) => {
    if (left.start !== right.start) return left.start - right.start;
    return left.end - right.end;
  });
  const merged: SequenceRange[] = [{ ...sorted[0] }];
  for (const range of sorted.slice(1)) {
    const previous = merged[merged.length - 1];
    if (range.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export type JetStreamControlKind = "flow-control" | "heartbeat";

/** Classify the control subjects used by JetStream consumer subscriptions. */
export function classifyControlSubject(
  subject: string,
): JetStreamControlKind | undefined {
  if (subject.startsWith("$JS.FC.")) return "flow-control";
  if (
    subject === "$JS.HEARTBEAT" ||
    subject.startsWith("$JS.HB.") ||
    subject === "$JS.HB"
  ) {
    return "heartbeat";
  }
  return undefined;
}

/**
 * Coordinates consumer deliveries, stream gaps and ordered publication.
 *
 * Publication is always by stream sequence. Consumer sequence is retained only
 * for acknowledgement/checkpoint accounting and redelivery diagnostics.
 */
export class JetStreamArchiver<T = unknown> {
  private readonly publishRecord?: (record: ArchiveRecord<T>) => void;
  private readonly requestRange?: (request: BackfillRequest) => void;
  private readonly commit?: (commit: ArchiveCommit) => void;
  private readonly holeCallback?: (hole: PermanentHole) => void;
  private readonly flowControlCallback?: (info: FlowControlInfo) => void;
  private readonly heartbeatCallback?: (info: HeartbeatInfo) => void;
  private readonly now: () => number;

  private nextStreamSeq: number;
  private committedStreamSeq: number;
  private highestObservedStreamSeq: number;
  private nextConsumerSeq: number;
  private committedConsumerSeq: number;
  private highestObservedConsumerSeq: number;

  private readonly pendingRecords = new Map<number, PendingRecord<T>>();
  private readonly permanentHoleSet = new Set<number>();
  private readonly permanentHoleList: PermanentHole[] = [];
  private readonly backfillRequests: BackfillRequest[] = [];
  private activeGap?: SequenceRange;
  private activeRequest?: BackfillRequest;

  private nextBackfillId = 1;
  private nextHoleId = 1;
  private redeliveryCount = 0;
  private duplicateCount = 0;
  private consumerRegressionCount = 0;
  private flowControlCount = 0;
  private lastFlowControlStreamSequence?: number;
  private lastFlowControlAt = 0;
  private heartbeatCount = 0;
  private lastHeartbeatAt = 0;
  private draining = false;

  constructor(options: JetStreamArchiverOptions<T> = {}) {
    const startStreamSeq = sequenceNumber(
      options.startStreamSeq,
      "INVALID_STREAM_SEQUENCE",
      "startStreamSeq",
      1,
    );
    const startConsumerSeq = sequenceNumber(
      options.startConsumerSeq,
      "INVALID_CONSUMER_SEQUENCE",
      "startConsumerSeq",
      0,
    );

    this.nextStreamSeq = startStreamSeq ?? 1;
    this.committedStreamSeq = this.nextStreamSeq - 1;
    this.highestObservedStreamSeq = this.committedStreamSeq;

    this.nextConsumerSeq = (startConsumerSeq ?? 0) + 1;
    this.committedConsumerSeq = startConsumerSeq ?? 0;
    this.highestObservedConsumerSeq = startConsumerSeq ?? 0;

    this.publishRecord = options.publish;
    this.requestRange = options.requestBackfill;
    this.commit = options.onCommit;
    this.holeCallback = options.onPermanentHole;
    this.flowControlCallback = options.onFlowControl;
    this.heartbeatCallback = options.onHeartbeat;
    this.now = options.now ?? Date.now;
  }

  /**
   * Ingest a consumer delivery. NATS.js's `msg.seq` is treated as the stream
   * sequence; `deliverySeq`, `info.deliverySequence` and
   * `meta.sequence.consumer` are accepted as the consumer sequence.
   */
  ingest(delivery: JetStreamDelivery<T>): IngestResult {
    const normalized = this.normalize(delivery, delivery.source ?? "live");
    return this.accept(normalized);
  }

  /** Alias for consumers whose callback is named `onMessage`. */
  handleMessage(delivery: JetStreamDelivery<T>): IngestResult {
    return this.ingest(delivery);
  }

  /** Alias for adapters that use a generic `push` method. */
  push(delivery: JetStreamDelivery<T>): IngestResult {
    return this.ingest(delivery);
  }

  /**
   * Apply a backfill response. Backfill records can arrive after later live
   * messages; both kinds are inserted into the same stream-sequence buffer.
   */
  handleBackfill(result: BackfillResult<T>): BackfillOutcome {
    const request = this.requestFor(result.requestId);
    const requestedRange = result.range
      ? normalizedRange(result.range, "backfill.range")
      : request?.range;

    if (!request && !requestedRange) {
      throw new JetStreamArchiverError(
        "BACKFILL_NOT_ACTIVE",
        "a backfill result needs an active request or an explicit range",
      );
    }

    if (
      request &&
      requestedRange &&
      !containsRange(request.range, requestedRange)
    ) {
      throw new JetStreamArchiverError(
        "BACKFILL_REQUEST_MISMATCH",
        `backfill range ${requestedRange.start}-${requestedRange.end} is outside ` +
          `active request ${request.range.start}-${request.range.end}`,
      );
    }

    const range = requestedRange ?? request?.range;
    if (!range) {
      throw new JetStreamArchiverError(
        "BACKFILL_NOT_ACTIVE",
        "a backfill range is required",
      );
    }

    const records = result.messages ?? result.records ?? [];
    let accepted = 0;
    let duplicates = 0;
    for (const record of records) {
      const normalized = this.normalize(record, "backfill");
      if (normalized.streamSeq < range.start || normalized.streamSeq > range.end) {
        continue;
      }
      if (this.acceptBackfillRecord(normalized)) accepted += 1;
      else duplicates += 1;
    }

    const explicitHoles = [
      ...selectionToRanges(result.holes),
      ...selectionToRanges(result.deleted),
      ...selectionToRanges(result.missing),
    ];
    const reason = result.holeReason ?? "deleted";
    const inferredHoles =
      result.complete === false ? [] : this.inferredHoleRanges(range);
    let holesRecorded = 0;
    for (const hole of mergeRanges([...explicitHoles, ...inferredHoles])) {
      holesRecorded += this.addHoles(
        hole.start,
        hole.end,
        reason,
        request?.id,
      );
    }

    let resolved = false;
    if (request) {
      resolved = this.isRangeResolved(request.range);
      if (resolved) {
        this.activeRequest = undefined;
        this.activeGap = undefined;
      }
    }

    const published = resolved || !request ? this.drain() : 0;
    return {
      requestId: request?.id,
      range,
      accepted,
      duplicates,
      holesRecorded,
      published,
      resolved,
    };
  }

  /** Alias for adapters whose callback is named `onBackfill`. */
  backfill(result: BackfillResult<T>): BackfillOutcome {
    return this.handleBackfill(result);
  }

  /**
   * Dispatch a control frame without touching application sequence state.
   * Useful when a consumer-state component exposes one callback for all
   * non-data frames.
   */
  handleControl(control: JetStreamControl): FlowControlInfo | HeartbeatInfo {
    if (control.type === "flow-control") {
      return this.handleFlowControl(control.streamSequence);
    }
    if (control.type === "heartbeat") {
      return this.handleHeartbeat(control.at);
    }
    throw new JetStreamArchiverError(
      "INVALID_CONTROL",
      `unknown control type: ${String((control as { type?: unknown }).type)}`,
    );
  }

  /**
   * Handle a control frame selected by subject. Flow-control payloads may be
   * objects, JSON strings or the UTF-8 bytes delivered by NATS.
   */
  handleControlMessage(
    subject: string,
    data?: unknown,
    at?: number | string | Date,
  ): FlowControlInfo | HeartbeatInfo {
    const kind = classifyControlSubject(subject);
    if (kind === "heartbeat") return this.handleHeartbeat(at);
    if (kind === "flow-control") {
      const content = decodeControlPayload(data);
      let streamSequence:
        | number
        | string
        | bigint
        | undefined;
      if (typeof content === "object" && content !== null) {
        const record = content as {
          stream?: number | string | bigint;
          streamSeq?: number | string | bigint;
          streamSequence?: number | string | bigint;
        };
        streamSequence = firstSequence([
          record.stream,
          record.streamSeq,
          record.streamSequence,
        ]);
      } else if (
        typeof content === "number" ||
        typeof content === "string" ||
        typeof content === "bigint"
      ) {
        streamSequence = content;
      }
      return this.handleFlowControl(streamSequence);
    }
    throw new JetStreamArchiverError(
      "INVALID_CONTROL",
      `not a JetStream control subject: ${subject}`,
    );
  }

  /**
   * Record a sequence that no longer exists in the stream (for example a 404
   * from `getMessage`). Holes are explicit so a transient fetch miss is never
   * silently treated as deletion.
   */
  markPermanentHole(
    selection: SequenceSelection,
    reason: HoleReason = "deleted",
  ): number {
    let count = 0;
    for (const range of mergeRanges(selectionToRanges(selection))) {
      count += this.addHoles(range.start, range.end, reason, this.activeRequest?.id);
    }
    if (
      this.activeRequest &&
      this.isRangeResolved(this.activeRequest.range)
    ) {
      this.activeRequest = undefined;
      this.activeGap = undefined;
    }
    if (!this.activeRequest) this.drain();
    return count;
  }

  /**
   * Flow-control frames only bound server output; they never advance either
   * stream or consumer application sequences.
   */
  handleFlowControl(
    input?:
      | number
      | string
      | bigint
      | {
          stream?: number | string | bigint;
          streamSeq?: number | string | bigint;
          streamSequence?: number | string | bigint;
        },
  ): FlowControlInfo {
    this.flowControlCount += 1;
    this.lastFlowControlAt = this.now();

    if (typeof input === "object" && input !== null) {
      const value = firstSequence([input.stream, input.streamSeq, input.streamSequence]);
      const parsed = sequenceNumber(
        value,
        "INVALID_STREAM_SEQUENCE",
        "flowControl.streamSequence",
        0,
      );
      if (parsed !== undefined) this.lastFlowControlStreamSequence = parsed;
    } else {
      const parsed = sequenceNumber(
        input,
        "INVALID_STREAM_SEQUENCE",
        "flowControl.streamSequence",
        0,
      );
      if (parsed !== undefined) this.lastFlowControlStreamSequence = parsed;
    }

    const info = this.flowControlInfo();
    this.flowControlCallback?.(info);
    return info;
  }

  /** Heartbeats are liveness signals and are not part of the message stream. */
  handleHeartbeat(at?: number | string | Date): HeartbeatInfo {
    this.heartbeatCount += 1;
    this.lastHeartbeatAt = timestampNumber(at, this.now());
    const info = this.heartbeatInfo();
    this.heartbeatCallback?.(info);
    return info;
  }

  /** Alias for flow-control callbacks. */
  flowControl(
    input?: Parameters<JetStreamArchiver<T>["handleFlowControl"]>[0],
  ): FlowControlInfo {
    return this.handleFlowControl(input);
  }

  /** Alias for heartbeat callbacks. */
  heartbeat(at?: number | string | Date): HeartbeatInfo {
    return this.handleHeartbeat(at);
  }

  /** True after no heartbeat has been observed for `timeoutMs`. */
  isHeartbeatStale(timeoutMs = 30_000, at = this.now()): boolean {
    if (this.heartbeatCount === 0) return true;
    return at - this.lastHeartbeatAt > timeoutMs;
  }

  /**
   * Immutable, serialization-friendly state. `stream.nextSeq` is the value to
   * persist as `startStreamSeq` when resuming.
   */
  snapshot(): ArchiveSnapshot {
    return {
      stream: {
        committedSeq: this.committedStreamSeq,
        nextSeq: this.nextStreamSeq,
        highestObservedSeq: this.highestObservedStreamSeq,
        pending: this.pendingRecords.size,
        commitPaused: this.activeRequest !== undefined,
        activeGap: this.activeGap ? { ...this.activeGap } : undefined,
      },
      consumer: {
        committedSeq: this.committedConsumerSeq,
        highestObservedSeq: this.highestObservedConsumerSeq,
        nextAssignedSeq: this.nextConsumerSeq,
        redeliveries: this.redeliveryCount,
        duplicates: this.duplicateCount,
        regressions: this.consumerRegressionCount,
      },
      backfill: {
        activeRequest: this.activeRequest ? cloneRequest(this.activeRequest) : undefined,
        requests: this.backfillRequests.map(cloneRequest),
      },
      permanentHoles: [...this.permanentHoleList]
        .sort((left, right) => left.start - right.start)
        .map(cloneHole),
      flowControl: this.flowControlInfo(),
      heartbeat: this.heartbeatInfo(),
    };
  }

  private normalize(
    delivery: JetStreamDelivery<T>,
    source: "live" | "backfill",
  ): NormalizedDelivery<T> {
    const streamValue = firstSequence([
      delivery.streamSeq,
      delivery.streamSequence,
      delivery.stream_seq,
      delivery.seq,
      delivery.sequence?.stream,
      delivery.info?.streamSeq,
      delivery.info?.streamSequence,
      delivery.meta?.sequence?.stream,
      delivery.metadata?.sequence?.stream,
    ]);
    const streamSeq = sequenceNumber(
      streamValue,
      "INVALID_STREAM_SEQUENCE",
      "stream sequence",
      1,
    );
    if (streamSeq === undefined) {
      throw new JetStreamArchiverError(
        "INVALID_STREAM_SEQUENCE",
        "delivery is missing a stream sequence",
      );
    }

    const consumerValue = firstSequence([
      delivery.consumerSeq,
      delivery.consumerSequence,
      delivery.consumer_seq,
      delivery.deliverySeq,
      delivery.deliverySequence,
      delivery.delivery_seq,
      delivery.sequence?.consumer,
      delivery.info?.deliverySeq,
      delivery.info?.deliverySequence,
      delivery.meta?.sequence?.consumer,
      delivery.metadata?.sequence?.consumer,
    ]);
    const consumerSeq = sequenceNumber(
      consumerValue,
      "INVALID_CONSUMER_SEQUENCE",
      "consumer sequence",
      0,
    );

    const redeliveryCountValue = sequenceNumber(
      delivery.redeliveryCount ?? delivery.redeliveredCount,
      "INVALID_CONSUMER_SEQUENCE",
      "redeliveryCount",
      0,
    );
    const infoRedeliveryCount = sequenceNumber(
      delivery.info?.redeliveryCount,
      "INVALID_CONSUMER_SEQUENCE",
      "info.redeliveryCount",
      0,
    );
    const redeliveryCount = Math.max(
      redeliveryCountValue ?? 0,
      infoRedeliveryCount ?? 0,
    );

    return {
      streamSeq,
      consumerSeq,
      data: Object.prototype.hasOwnProperty.call(delivery, "data")
        ? delivery.data
        : delivery.payload,
      subject: delivery.subject,
      headers: delivery.headers,
      timestamp: timestampNumber(
        delivery.timestamp ?? delivery.time ?? delivery.info?.timestamp,
        this.now(),
      ),
      redelivery:
        delivery.redelivery === true ||
        delivery.redelivered === true ||
        redeliveryCount > 0,
      redeliveryCount,
      source,
    };
  }

  private accept(delivery: NormalizedDelivery<T>): IngestResult {
    const seq = delivery.streamSeq;
    const hadActiveGap = this.activeRequest !== undefined;
    const consumerSeq = this.accountForDelivery(delivery);
    this.highestObservedStreamSeq = Math.max(this.highestObservedStreamSeq, seq);

    if (this.isAlreadyAccounted(seq) || this.pendingRecords.has(seq)) {
      this.duplicateCount += 1;
      if (delivery.redelivery) this.redeliveryCount += 1;
      return {
        accepted: false,
        duplicate: true,
        buffered: this.pendingRecords.has(seq),
        published: 0,
        gap: this.activeGap ? { ...this.activeGap } : undefined,
      };
    }

    if (seq < this.nextStreamSeq) {
      this.duplicateCount += 1;
      if (delivery.redelivery) this.redeliveryCount += 1;
      return {
        accepted: false,
        duplicate: true,
        buffered: false,
        published: 0,
        gap: this.activeGap ? { ...this.activeGap } : undefined,
      };
    }

    if (delivery.redelivery) this.redeliveryCount += 1;
    this.pendingRecords.set(seq, {
      record: this.archiveRecord(delivery, consumerSeq),
    });
    this.resolveActiveIfBuffered();

    let createdGap: SequenceRange | undefined;
    if (!hadActiveGap && seq > this.nextStreamSeq && !this.activeRequest) {
      createdGap = this.openGap(seq - 1);
    }

    const published = this.drain();
    return {
      accepted: true,
      duplicate: false,
      buffered: this.pendingRecords.has(seq),
      published,
      gap: createdGap ?? (this.activeGap ? { ...this.activeGap } : undefined),
    };
  }

  private acceptBackfillRecord(delivery: NormalizedDelivery<T>): boolean {
    const seq = delivery.streamSeq;
    const consumerSeq = this.accountForDelivery(delivery);
    this.highestObservedStreamSeq = Math.max(this.highestObservedStreamSeq, seq);
    if (
      this.isAlreadyAccounted(seq) ||
      this.pendingRecords.has(seq) ||
      this.permanentHoleSet.has(seq)
    ) {
      this.duplicateCount += 1;
      return false;
    }

    this.pendingRecords.set(seq, {
      record: this.archiveRecord(delivery, consumerSeq),
    });
    return true;
  }

  private accountForDelivery(delivery: NormalizedDelivery<T>): number | undefined {
    if (delivery.source === "backfill") {
      const supplied = delivery.consumerSeq;
      if (supplied !== undefined) {
        this.highestObservedConsumerSeq = Math.max(
          this.highestObservedConsumerSeq,
          supplied,
        );
        this.nextConsumerSeq = Math.max(this.nextConsumerSeq, supplied + 1);
      }
      return supplied;
    }

    const supplied = delivery.consumerSeq;
    if (supplied === undefined) return undefined;

    if (supplied < this.highestObservedConsumerSeq) {
      this.consumerRegressionCount += 1;
    }
    this.highestObservedConsumerSeq = Math.max(
      this.highestObservedConsumerSeq,
      supplied,
    );
    this.nextConsumerSeq = Math.max(this.nextConsumerSeq, supplied + 1);
    return supplied;
  }

  private archiveRecord(
    delivery: NormalizedDelivery<T>,
    consumerSeq: number | undefined,
  ): ArchiveRecord<T> {
    return {
      streamSeq: delivery.streamSeq,
      streamSequence: delivery.streamSeq,
      consumerSeq,
      consumerSequence: consumerSeq,
      data: delivery.data,
      subject: delivery.subject,
      headers: delivery.headers,
      timestamp: delivery.timestamp,
      redelivery: delivery.redelivery,
      redeliveryCount: delivery.redeliveryCount,
      source: delivery.source,
    };
  }

  private isAlreadyAccounted(seq: number): boolean {
    return seq <= this.committedStreamSeq || this.permanentHoleSet.has(seq);
  }

  private openGap(end: number): SequenceRange | undefined {
    if (this.activeRequest || end < this.nextStreamSeq) return undefined;

    const range: SequenceRange = { start: this.nextStreamSeq, end };
    const request: BackfillRequest = {
      id: this.nextBackfillId,
      start: range.start,
      end: range.end,
      range: { ...range },
      streamRange: { ...range },
      reason: "stream-gap",
      requestedAt: this.now(),
    };
    this.nextBackfillId += 1;
    this.activeGap = { ...range };
    this.activeRequest = request;
    this.backfillRequests.push(request);
    this.requestRange?.(request);
    return { ...range };
  }

  /**
   * Publish every contiguous record, skipping only holes that were explicitly
   * proven permanent. No drain occurs while a gap is still being repaired.
   */
  private drain(): number {
    if (this.activeRequest) return 0;
    if (this.draining) return 0;
    this.draining = true;

    let published = 0;
    const crossedHoles: PermanentHole[] = [];

    try {
      while (true) {
        const seq = this.nextStreamSeq;

        if (this.permanentHoleSet.has(seq)) {
          const hole = this.permanentHoleList.find(
            (candidate) => candidate.start <= seq && candidate.end >= seq,
          );
          if (hole && !crossedHoles.includes(hole)) crossedHoles.push(hole);
          this.nextStreamSeq += 1;
          this.committedStreamSeq = this.nextStreamSeq - 1;
          continue;
        }

        const pending = this.pendingRecords.get(seq);
        if (!pending) break;

        this.publishRecord?.(pending.record);
        this.pendingRecords.delete(seq);
        this.nextStreamSeq += 1;
        this.committedStreamSeq = this.nextStreamSeq - 1;
        if (pending.record.consumerSeq !== undefined) {
          this.committedConsumerSeq = Math.max(
            this.committedConsumerSeq,
            pending.record.consumerSeq,
          );
        }
        published += 1;
      }

      if (published > 0 || crossedHoles.length > 0) {
        this.commit?.({
          streamSeq: this.committedStreamSeq,
          streamSequence: this.committedStreamSeq,
          consumerSeq: this.committedConsumerSeq,
          consumerSequence: this.committedConsumerSeq,
          published,
          holes: crossedHoles.map(cloneHole),
        });
      }
    } finally {
      this.draining = false;
    }

    if (!this.activeRequest && this.pendingRecords.size > 0) {
      const nextPending = this.lowestPendingSequence();
      if (nextPending !== undefined && nextPending > this.nextStreamSeq) {
        this.openGap(nextPending - 1);
      }
    }

    return published;
  }

  private lowestPendingSequence(): number | undefined {
    let lowest: number | undefined;
    for (const seq of this.pendingRecords.keys()) {
      if (lowest === undefined || seq < lowest) lowest = seq;
    }
    return lowest;
  }

  private addHoles(
    start: number,
    end: number,
    reason: HoleReason,
    requestId?: number,
  ): number {
    let added = 0;
    let runStart: number | undefined;

    const flushRun = (stop: number) => {
      if (runStart === undefined) return;
      const hole = this.createHole(runStart, stop - 1, reason, requestId);
      added += hole.sequences.length;
      runStart = undefined;
    };

    for (let seq = start; seq <= end; seq += 1) {
      const eligible =
        seq > this.committedStreamSeq &&
        !this.permanentHoleSet.has(seq) &&
        !this.pendingRecords.has(seq);
      if (eligible) {
        if (runStart === undefined) runStart = seq;
      } else {
        flushRun(seq);
      }
    }
    flushRun(end + 1);
    return added;
  }

  private createHole(
    start: number,
    end: number,
    reason: HoleReason,
    requestId?: number,
  ): PermanentHole {
    const sequences: number[] = [];
    for (let seq = start; seq <= end; seq += 1) {
      this.permanentHoleSet.add(seq);
      sequences.push(seq);
    }
    const hole: PermanentHole = {
      id: this.nextHoleId,
      start,
      end,
      range: { start, end },
      streamRange: { start, end },
      sequences,
      reason,
      detectedAt: this.now(),
      requestId,
    };
    this.nextHoleId += 1;
    this.permanentHoleList.push(hole);
    this.holeCallback?.(cloneHole(hole));
    return hole;
  }

  private inferredHoleRanges(range: SequenceRange): SequenceRange[] {
    const ranges: SequenceRange[] = [];
    let runStart: number | undefined;

    const flushRun = (stop: number) => {
      if (runStart === undefined) return;
      ranges.push({ start: runStart, end: stop - 1 });
      runStart = undefined;
    };

    for (let seq = range.start; seq <= range.end; seq += 1) {
      const unresolved =
        seq > this.committedStreamSeq &&
        !this.pendingRecords.has(seq) &&
        !this.permanentHoleSet.has(seq);
      if (unresolved) {
        if (runStart === undefined) runStart = seq;
      } else {
        flushRun(seq);
      }
    }
    flushRun(range.end + 1);
    return ranges;
  }

  private isRangeResolved(range: SequenceRange): boolean {
    const first = Math.max(range.start, this.nextStreamSeq);
    for (let seq = first; seq <= range.end; seq += 1) {
      if (
        seq > this.committedStreamSeq &&
        !this.pendingRecords.has(seq) &&
        !this.permanentHoleSet.has(seq)
      ) {
        return false;
      }
    }
    return true;
  }

  private resolveActiveIfBuffered(): void {
    if (
      this.activeRequest &&
      this.isRangeResolved(this.activeRequest.range)
    ) {
      this.activeRequest = undefined;
      this.activeGap = undefined;
    }
  }

  private requestFor(requestId?: number): BackfillRequest | undefined {
    if (this.activeRequest) {
      if (requestId !== undefined && requestId !== this.activeRequest.id) {
        throw new JetStreamArchiverError(
          "BACKFILL_REQUEST_MISMATCH",
          `backfill request ${requestId} is not active; ` +
            `request ${this.activeRequest.id} is waiting`,
        );
      }
      return this.activeRequest;
    }
    if (requestId === undefined) return undefined;
    const request = this.backfillRequests.find(
      (candidate) => candidate.id === requestId,
    );
    if (!request) {
      throw new JetStreamArchiverError(
        "BACKFILL_REQUEST_MISMATCH",
        `unknown backfill request ${requestId}`,
      );
    }
    return request;
  }

  private flowControlInfo(): FlowControlInfo {
    return {
      count: this.flowControlCount,
      lastStreamSequence: this.lastFlowControlStreamSequence,
      lastAt: this.lastFlowControlAt,
    };
  }

  private heartbeatInfo(): HeartbeatInfo {
    return {
      count: this.heartbeatCount,
      lastAt: this.lastHeartbeatAt,
    };
  }
}

/** Short alias used by some integration layers. */
export {
  JetStreamArchiver as JetStreamArchive,
  JetStreamArchiver as JetStreamSequenceArchiver,
};

export function createJetStreamArchiver<T = unknown>(
  options: JetStreamArchiverOptions<T> = {},
): JetStreamArchiver<T> {
  return new JetStreamArchiver(options);
}

export interface JetStreamConsumerStateHandlers<T = unknown> {
  message: (delivery: JetStreamDelivery<T>) => IngestResult;
  redelivery: (delivery: JetStreamDelivery<T>) => IngestResult;
  flowControl: (
    input?: Parameters<JetStreamArchiver<T>["handleFlowControl"]>[0],
  ) => FlowControlInfo;
  heartbeat: (at?: number | string | Date) => HeartbeatInfo;
  backfill: (result: BackfillResult<T>) => BackfillOutcome;
}

/**
 * Bind an archiver to the callbacks normally exposed by a consumer-state
 * component. The returned object can be spread into that component directly.
 */
export function createConsumerStateHandlers<T = unknown>(
  archiver: JetStreamArchiver<T>,
): JetStreamConsumerStateHandlers<T> {
  return {
    message: (delivery) => archiver.ingest(delivery),
    redelivery: (delivery) =>
      archiver.ingest({
        ...delivery,
        redelivery: true,
        redeliveryCount: Math.max(1, delivery.redeliveryCount ?? 0),
      }),
    flowControl: (input) => archiver.handleFlowControl(input),
    heartbeat: (at) => archiver.handleHeartbeat(at),
    backfill: (result) => archiver.handleBackfill(result),
  };
}

function selectionToRanges(selection?: SequenceSelection): SequenceRange[] {
  if (selection === undefined) return [];
  if (typeof selection === "number") {
    return [normalizedRange({ start: selection, end: selection }, "hole")];
  }
  if (Array.isArray(selection)) {
    return selection.flatMap((item) =>
      typeof item === "number"
        ? [normalizedRange({ start: item, end: item }, "hole")]
        : [normalizedRange(item, "hole")],
    );
  }
  return [normalizedRange(selection as SequenceRange, "hole")];
}

function decodeControlPayload(data: unknown): unknown {
  if (data === undefined || data === null) return undefined;
  if (data instanceof Uint8Array) {
    try {
      return JSON.parse(new TextDecoder().decode(data));
    } catch {
      return undefined;
    }
  }
  if (typeof data === "string") {
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  }
  return data;
}

function cloneRequest(request: BackfillRequest): BackfillRequest {
  return {
    ...request,
    range: { ...request.range },
    streamRange: { ...request.streamRange },
  };
}

function cloneHole(hole: PermanentHole): PermanentHole {
  return {
    ...hole,
    range: { ...hole.range },
    streamRange: { ...hole.streamRange },
    sequences: [...hole.sequences],
  };
}

export default JetStreamArchiver;
