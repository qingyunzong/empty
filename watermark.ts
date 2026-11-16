/**
 * Partition-aware event-time watermark coordination.
 *
 * The coordinator keeps one watermark state per partition and derives the
 * global watermark from the non-idle partitions.  Watermarks are deliberately
 * monotonic: adding/removing partitions, restoring a checkpoint, or receiving
 * an old event can never move the global watermark backwards.
 */

export type PartitionId = string | number;
export type TimestampInput = number | Date;

export type WatermarkTriggerReason =
  | "initial"
  | "event"
  | "idle"
  | "reactivate"
  | "partition-added"
  | "partition-removed"
  | "configuration"
  | "restore";

export type WatermarkListener = (
  watermark: number,
  trigger: WatermarkTrigger,
) => void;

export type TriggerListener = (trigger: WatermarkTrigger) => void;

export interface WatermarkOptions {
  /** Allowed event-time disorder for partitions created by this coordinator. */
  outOfOrderness?: number;
  maxOutOfOrderness?: number;
  maxOutOfOrderMs?: number;
  allowedOutOfOrderness?: number;
  outOfOrderBound?: number;
  /** Common synonym for out-of-orderness in streaming APIs. */
  maxLateness?: number;

  /** How long past the watermark an event is still considered acceptable. */
  allowedLateness?: number;
  allowedLatenessMs?: number;
  lateness?: number;

  /** Optional idle timeout in milliseconds, used by `tick()`. */
  idleTimeout?: number;
  idleTimeoutMs?: number;

  policy?: WatermarkPolicy;

  initialWatermark?: number;
  startWatermark?: number;
  emitInitial?: boolean;

  /**
   * When every partition is idle, advance to the greatest known idle
   * watermark instead of holding the current value.  Disabled by default.
   */
  advanceWhenAllIdle?: boolean;

  maxTriggerHistory?: number;

  onWatermark?: WatermarkListener;
  onTrigger?: TriggerListener;
}

export interface PartitionOptions {
  outOfOrderness?: number;
  maxOutOfOrderness?: number;
  maxOutOfOrderMs?: number;
  allowedOutOfOrderness?: number;
  outOfOrderBound?: number;
  maxLateness?: number;
  allowedLateness?: number;
  allowedLatenessMs?: number;
  lateness?: number;

  /** Initialise a partition with an already-known event time. */
  initialTimestamp?: number;
  maxTimestamp?: number;
  timestamp?: number;

  idle?: boolean;
  idleGeneration?: number;
}

export interface EventOptions {
  outOfOrderness?: number;
  maxOutOfOrderness?: number;
  maxOutOfOrderMs?: number;
  allowedOutOfOrderness?: number;
  outOfOrderBound?: number;
  maxLateness?: number;
  allowedLateness?: number;
  allowedLatenessMs?: number;
  lateness?: number;
}

export interface EventInput extends EventOptions {
  partition?: PartitionId;
  partitionId?: PartitionId;
  key?: PartitionId;
  id?: PartitionId;
  timestamp?: TimestampInput;
  eventTime?: TimestampInput;
  eventTimeMs?: number;
  event_time_ms?: number;
  time?: TimestampInput;
  arrivalTime?: number;
  arrivalTimeMs?: number;
  arrival_time_ms?: number;
  value?: number;
  idle?: boolean;
}

export interface WatermarkTrigger {
  sequence: number;
  seq: number;
  watermark: number;
  globalWatermark: number;
  previousWatermark: number;
  reason: WatermarkTriggerReason;
  type: WatermarkTriggerReason;
  partitionId?: string;
  eventTimestamp?: number;
  idleGeneration?: number;
}

export interface PartitionState {
  id: string;
  initialized: boolean;
  maxTimestamp: number | null;
  maxEventTime: number | null;
  watermark: number;
  partitionWatermark: number;
  outOfOrderness: number;
  allowedLateness: number;
  idle: boolean;
  idleGeneration: number;
  generation: number;
  eventCount: number;
  lateEventCount: number;
  lastEventTimestamp: number | null;
  lastActivity: number;
  lastArrival: number;
  lastArrivalMs: number;
}

export interface ObservationResult {
  partitionId: string;
  timestamp: number;
  watermark: number;
  globalWatermark: number;
  previousWatermark: number;
  partitionWatermark: number;
  advanced: boolean;
  emitted: boolean;
  late: boolean;
  isLate: boolean;
  status: EventStatus;
  eventStatus: EventStatus;
  withinAllowedLateness: boolean;
  tooLate: boolean;
  accepted: boolean;
  reactivated: boolean;
  idle: boolean;
  idleGeneration: number;
  eventCount: number;
  lateEventCount: number;
  sequence: number | null;
  trigger: WatermarkTrigger | null;
}

export interface SnapshotPartition {
  id: string;
  maxTimestamp: number | null;
  outOfOrderness: number;
  allowedLateness: number;
  idle: boolean;
  idleGeneration: number;
  eventCount: number;
  lateEventCount: number;
  lastEventTimestamp: number | null;
  lastActivity?: number;
  initialized?: boolean;
}

export interface WatermarkSnapshot {
  version: 1;
  watermark: number | null;
  sequence: number;
  config: {
    outOfOrderness: number;
    allowedLateness: number;
    idleTimeout: number | null;
    advanceWhenAllIdle: boolean;
  };
  partitions: Record<string, SnapshotPartition>;
  triggers?: WatermarkTrigger[];
}

export type WatermarkSnapshotInput =
  | WatermarkSnapshot
  | string
  | Record<string, unknown>;

export interface RestoreOptions {
  /** Do not replace coordinator defaults with the snapshot defaults. */
  preserveConfig?: boolean;
  /** Emit one event for the restored watermark when it is an advance. */
  emit?: boolean;
}

interface ResolvedOptions {
  outOfOrderness: number;
  allowedLateness: number;
  idleTimeout: number | null;
  initialWatermark: number;
  emitInitial: boolean;
  advanceWhenAllIdle: boolean;
  maxTriggerHistory: number;
}

interface InternalPartition {
  id: string;
  initialized: boolean;
  maxTimestamp: number;
  outOfOrderness: number;
  allowedLateness: number;
  idle: boolean;
  idleGeneration: number;
  eventCount: number;
  lateEventCount: number;
  lastEventTimestamp: number | null;
  lastActivity: number;
}

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function normalizeId(id: PartitionId): string {
  if (typeof id === "string") {
    if (id.length === 0) {
      throw new TypeError("partition id must not be empty");
    }
    return id;
  }
  if (typeof id === "number" && Number.isFinite(id)) {
    return String(id);
  }
  throw new TypeError("partition id must be a string or a finite number");
}

function normalizeTimestamp(value: TimestampInput | unknown, field: string): number {
  let timestamp: number;
  if (value instanceof Date) {
    timestamp = value.getTime();
  } else if (typeof value === "number") {
    timestamp = value;
  } else if (typeof value === "bigint") {
    timestamp = Number(value);
  } else if (typeof value === "string" && value.trim() !== "") {
    timestamp = Number(value);
  } else {
    throw new TypeError(`${field} must be a number, Date, or numeric string`);
  }

  if (Number.isNaN(timestamp)) {
    throw new TypeError(`${field} must not be NaN`);
  }
  return timestamp;
}

function normalizeBound(value: number | undefined, field: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative number`);
  }
  return value;
}

function normalizeTimeout(value: number | undefined, fallback: number | null): number | null {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError("idleTimeout must be a non-negative finite number");
  }
  return value;
}

function outOfOrdernessOf(options: EventOptions | PartitionOptions | WatermarkOptions): number | undefined {
  const direct = firstDefined(
    options.outOfOrderness,
    options.maxOutOfOrderness,
    options.maxOutOfOrderMs,
    options.allowedOutOfOrderness,
    options.outOfOrderBound,
    options.maxLateness,
  );
  return direct ?? (options as WatermarkOptions).policy?.maxOutOfOrderMs;
}

function allowedLatenessOf(options: EventOptions | PartitionOptions | WatermarkOptions): number | undefined {
  return firstDefined(
    options.allowedLateness,
    options.allowedLatenessMs,
    options.lateness,
    (options as WatermarkOptions).policy?.allowedLatenessMs,
  );
}

function resolveOptions(options: WatermarkOptions = {}): ResolvedOptions {
  const policy = options.policy;
  const initialWatermark = firstDefined(options.initialWatermark, options.startWatermark) ?? -Infinity;
  if (typeof initialWatermark !== "number" || Number.isNaN(initialWatermark)) {
    throw new RangeError("initialWatermark must be a number");
  }

  return {
    outOfOrderness: normalizeBound(outOfOrdernessOf(options), "outOfOrderness", 0),
    allowedLateness: normalizeBound(allowedLatenessOf(options), "allowedLateness", 0),
    idleTimeout: normalizeTimeout(
      firstDefined(options.idleTimeout, options.idleTimeoutMs, policy?.idleTimeoutMs),
      null,
    ),
    initialWatermark,
    emitInitial: options.emitInitial === true,
    advanceWhenAllIdle: options.advanceWhenAllIdle === true,
    maxTriggerHistory:
      options.maxTriggerHistory === undefined
        ? Number.POSITIVE_INFINITY
        : normalizeBound(options.maxTriggerHistory, "maxTriggerHistory", 0),
  };
}

function toPublicPartition(partition: InternalPartition): PartitionState {
  const watermark = partition.initialized
    ? partition.maxTimestamp - partition.outOfOrderness
    : -Infinity;
  return {
    id: partition.id,
    initialized: partition.initialized,
    maxTimestamp: partition.initialized ? partition.maxTimestamp : null,
    maxEventTime: partition.initialized ? partition.maxTimestamp : null,
    watermark,
    partitionWatermark: watermark,
    outOfOrderness: partition.outOfOrderness,
    allowedLateness: partition.allowedLateness,
    idle: partition.idle,
    idleGeneration: partition.idleGeneration,
    generation: partition.idleGeneration,
    eventCount: partition.eventCount,
    lateEventCount: partition.lateEventCount,
    lastEventTimestamp: partition.lastEventTimestamp,
    lastActivity: partition.lastActivity,
    lastArrival: partition.lastActivity,
    lastArrivalMs: partition.lastActivity,
  };
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function numberOrNegativeInfinity(value: unknown): number {
  if (value === null || value === undefined) {
    return -Infinity;
  }
  if (typeof value !== "number" || Number.isNaN(value)) {
    return -Infinity;
  }
  return value;
}

function numberOrDefault(value: unknown, fallback: number): number {
  const normalized = numberOrNegativeInfinity(value);
  return normalized === -Infinity ? fallback : normalized;
}

function eventTimeOf(event: unknown, fallback?: number): number {
  if (typeof event === "number" || event instanceof Date || typeof event === "string") {
    return normalizeTimestamp(event, "eventTime");
  }
  if (typeof event === "object" && event !== null) {
    const source = event as EventInput & {
      eventTimeMs?: number;
      event_time_ms?: number;
    };
    const value = firstDefined(
      source.eventTime,
      source.timestamp,
      source.time,
      source.eventTimeMs,
      source.event_time_ms,
    );
    if (value !== undefined) {
      return normalizeTimestamp(value, "eventTime");
    }
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new TypeError("event must contain an event time");
}

function arrivalTimeOf(event: unknown, fallback: number): number {
  if (typeof event === "object" && event !== null) {
    const source = event as EventInput & {
      arrivalTimeMs?: number;
      arrival_time_ms?: number;
    };
    const value = firstDefined(
      source.arrivalTime,
      source.arrivalTimeMs,
      source.arrival_time_ms,
    );
    if (value !== undefined) {
      return normalizeTimestamp(value, "arrivalTime");
    }
  }
  return fallback;
}

/** Policy used by `WatermarkState` and by policy-based coordinator construction. */
export class WatermarkPolicy {
  readonly maxOutOfOrderMs: number;
  readonly allowedLatenessMs: number;
  readonly idleTimeoutMs: number;

  constructor(
    maxOutOfOrderMs = 0,
    allowedLatenessMs = 0,
    idleTimeoutMs = 0,
  ) {
    this.maxOutOfOrderMs = normalizeBound(
      maxOutOfOrderMs,
      "maxOutOfOrderMs",
      0,
    );
    this.allowedLatenessMs = normalizeBound(
      allowedLatenessMs,
      "allowedLatenessMs",
      0,
    );
    this.idleTimeoutMs = normalizeTimeout(idleTimeoutMs, 0) ?? 0;
  }

  get maxOutOfOrder(): number {
    return this.maxOutOfOrderMs;
  }

  get allowedLateness(): number {
    return this.allowedLatenessMs;
  }

  get idleTimeout(): number {
    return this.idleTimeoutMs;
  }

  get max_out_of_order_ms(): number {
    return this.maxOutOfOrderMs;
  }

  get allowed_lateness_ms(): number {
    return this.allowedLatenessMs;
  }

  get idle_timeout_ms(): number {
    return this.idleTimeoutMs;
  }

  toJSON(): {
    maxOutOfOrderMs: number;
    allowedLatenessMs: number;
    idleTimeoutMs: number;
  } {
    return {
      maxOutOfOrderMs: this.maxOutOfOrderMs,
      allowedLatenessMs: this.allowedLatenessMs,
      idleTimeoutMs: this.idleTimeoutMs,
    };
  }

  static new(
    maxOutOfOrderMs = 0,
    allowedLatenessMs = 0,
    idleTimeoutMs = 0,
  ): WatermarkPolicy {
    return new WatermarkPolicy(
      maxOutOfOrderMs,
      allowedLatenessMs,
      idleTimeoutMs,
    );
  }
}

export function defaultPolicy(): WatermarkPolicy {
  return new WatermarkPolicy(60_000, 120_000, 300_000);
}

export function default_policy(): WatermarkPolicy {
  return defaultPolicy();
}

export interface StreamEventInput {
  key?: string;
  partition?: PartitionId;
  partitionId?: PartitionId;
  eventTime?: TimestampInput;
  eventTimeMs?: number;
  event_time_ms?: number;
  timestamp?: TimestampInput;
  time?: TimestampInput;
  arrivalTime?: number;
  arrivalTimeMs?: number;
  arrival_time_ms?: number;
  value?: number;
}

/** Event shape compatible with the watermark-kit APIs. */
export class StreamEvent {
  key: string;
  eventTimeMs: number;
  arrivalTimeMs: number;
  value: number;

  constructor(
    key: string | StreamEventInput,
    eventTimeMs = 0,
    arrivalTimeMs = eventTimeMs,
    value = 0,
  ) {
    if (typeof key === "object" && key !== null) {
      const source = key;
      const partition = firstDefined(
        source.key,
        source.partition,
        source.partitionId,
      );
      if (partition === undefined) {
        throw new TypeError("stream event key is required");
      }
      this.key = String(partition);
      this.eventTimeMs = eventTimeOf(source);
      this.arrivalTimeMs = arrivalTimeOf(source, this.eventTimeMs);
      this.value = source.value ?? 0;
      return;
    }

    this.key = normalizeId(key);
    this.eventTimeMs = normalizeTimestamp(eventTimeMs, "eventTimeMs");
    this.arrivalTimeMs = normalizeTimestamp(arrivalTimeMs, "arrivalTimeMs");
    this.value = value;
  }

  get eventTime(): number {
    return this.eventTimeMs;
  }

  get event_time_ms(): number {
    return this.eventTimeMs;
  }

  get arrivalTime(): number {
    return this.arrivalTimeMs;
  }

  get arrival_time_ms(): number {
    return this.arrivalTimeMs;
  }

  toJSON(): {
    key: string;
    eventTimeMs: number;
    arrivalTimeMs: number;
    value: number;
  } {
    return {
      key: this.key,
      eventTimeMs: this.eventTimeMs,
      arrivalTimeMs: this.arrivalTimeMs,
      value: this.value,
    };
  }

  static new(
    key: string | StreamEventInput,
    eventTimeMs?: number,
    arrivalTimeMs?: number,
    value?: number,
  ): StreamEvent {
    return new StreamEvent(key, eventTimeMs, arrivalTimeMs, value);
  }
}

export const EventStatus = {
  OnTime: "OnTime",
  Late: "Late",
  TooLate: "TooLate",
} as const;

export type EventStatus = (typeof EventStatus)[keyof typeof EventStatus];

/** Standalone per-partition watermark state. */
export class WatermarkState {
  policy: WatermarkPolicy;
  maxEventTimeMs: number;
  currentWatermarkMs: number;
  lastArrivalMs: number;
  initialized: boolean;

  constructor(policy: WatermarkPolicy | WatermarkOptions = {}) {
    this.policy =
      policy instanceof WatermarkPolicy
        ? policy
        : new WatermarkPolicy(
            outOfOrdernessOf(policy) ?? 0,
            allowedLatenessOf(policy) ?? 0,
            firstDefined(
              policy.idleTimeout,
              policy.idleTimeoutMs,
              (policy as WatermarkOptions).policy?.idleTimeoutMs,
            ) ?? 0,
          );
    this.maxEventTimeMs = 0;
    this.currentWatermarkMs = 0;
    this.lastArrivalMs = 0;
    this.initialized = false;
  }

  get max_event_time_ms(): number {
    return this.maxEventTimeMs;
  }

  get maxEventTime(): number {
    return this.maxEventTimeMs;
  }

  get current_watermark_ms(): number {
    return this.currentWatermarkMs;
  }

  get currentWatermark(): number {
    return this.currentWatermarkMs;
  }

  get last_arrival_ms(): number {
    return this.lastArrivalMs;
  }

  get lastArrival(): number {
    return this.lastArrivalMs;
  }

  get watermark(): number {
    return this.currentWatermarkMs;
  }

  observe(event: StreamEvent | StreamEventInput | number): this {
    const eventTime = eventTimeOf(event);
    const arrivalTime = arrivalTimeOf(event, eventTime);
    const maxEventTime =
      !this.initialized || eventTime > this.maxEventTimeMs
        ? eventTime
        : this.maxEventTimeMs;
    const nextWatermark = maxEventTime - this.policy.maxOutOfOrderMs;
    const currentWatermark =
      this.initialized && this.currentWatermarkMs > nextWatermark
        ? this.currentWatermarkMs
        : nextWatermark;

    this.maxEventTimeMs = maxEventTime;
    this.currentWatermarkMs = currentWatermark;
    this.lastArrivalMs = Math.max(this.lastArrivalMs, arrivalTime);
    this.initialized = true;
    return this;
  }

  classify(event: StreamEvent | StreamEventInput | number): EventStatus {
    const eventTime = eventTimeOf(event);
    if (!this.initialized || eventTime >= this.currentWatermarkMs) {
      return EventStatus.OnTime;
    }
    if (
      eventTime >=
      this.currentWatermarkMs - this.policy.allowedLatenessMs
    ) {
      return EventStatus.Late;
    }
    return EventStatus.TooLate;
  }

  deadlineFor(eventTimeMs: number): number {
    return (
      normalizeTimestamp(eventTimeMs, "eventTimeMs") +
      this.policy.allowedLatenessMs
    );
  }

  deadline_for(eventTimeMs: number): number {
    return this.deadlineFor(eventTimeMs);
  }

  markIdle(nowMs: number = Date.now()): boolean {
    return (
      this.initialized &&
      nowMs >= this.lastArrivalMs + this.policy.idleTimeoutMs
    );
  }

  mark_idle(nowMs: number = Date.now()): boolean {
    return this.markIdle(nowMs);
  }

  toJSON(): {
    policy: ReturnType<WatermarkPolicy["toJSON"]>;
    maxEventTimeMs: number;
    currentWatermarkMs: number;
    lastArrivalMs: number;
    initialized: boolean;
  } {
    return {
      policy: this.policy.toJSON(),
      maxEventTimeMs: this.maxEventTimeMs,
      currentWatermarkMs: this.currentWatermarkMs,
      lastArrivalMs: this.lastArrivalMs,
      initialized: this.initialized,
    };
  }

  snapshot(): ReturnType<WatermarkState["toJSON"]> {
    return this.toJSON();
  }

  serialize(): string {
    return JSON.stringify(this.toJSON());
  }

  restore(snapshot: string | Record<string, unknown>): this {
    const source = (
      typeof snapshot === "string" ? JSON.parse(snapshot) : snapshot
    ) as Record<string, unknown>;
    const policySource =
      typeof source.policy === "object" && source.policy !== null
        ? (source.policy as Record<string, unknown>)
        : source;
    this.policy = new WatermarkPolicy(
      numberOrDefault(
        firstDefined(
          policySource.maxOutOfOrderMs,
          policySource.max_out_of_order_ms,
          policySource.outOfOrderness,
        ),
        this.policy.maxOutOfOrderMs,
      ),
      numberOrDefault(
        firstDefined(
          policySource.allowedLatenessMs,
          policySource.allowed_lateness_ms,
          policySource.allowedLateness,
        ),
        this.policy.allowedLatenessMs,
      ),
      numberOrDefault(
        firstDefined(
          policySource.idleTimeoutMs,
          policySource.idle_timeout_ms,
          policySource.idleTimeout,
        ),
        this.policy.idleTimeoutMs,
      ),
    );
    this.maxEventTimeMs = numberOrDefault(
      firstDefined(
        source.maxEventTimeMs,
        source.max_event_time_ms,
        source.maxTimestamp,
      ),
      this.maxEventTimeMs,
    );
    this.currentWatermarkMs = numberOrDefault(
      firstDefined(
        source.currentWatermarkMs,
        source.current_watermark_ms,
        source.watermark,
      ),
      this.currentWatermarkMs,
    );
    this.lastArrivalMs = numberOrDefault(
      firstDefined(
        source.lastArrivalMs,
        source.last_arrival_ms,
        source.lastArrival,
      ),
      this.lastArrivalMs,
    );
    this.initialized = source.initialized === true;
    return this;
  }

  static fromJSON(snapshot: string | Record<string, unknown>): WatermarkState {
    return new WatermarkState().restore(snapshot);
  }

  static fromSnapshot(snapshot: string | Record<string, unknown>): WatermarkState {
    return WatermarkState.fromJSON(snapshot);
  }

  static new(policy: WatermarkPolicy | WatermarkOptions = {}): WatermarkState {
    return new WatermarkState(policy);
  }
}

/** A named partition paired with its watermark state. */
export class PartitionWatermark {
  partition: string;
  state: WatermarkState;
  idle: boolean;

  constructor(
    partition: PartitionId,
    state: WatermarkState = new WatermarkState(),
    idle = false,
  ) {
    this.partition = normalizeId(partition);
    this.state = state;
    this.idle = idle;
  }

  get name(): string {
    return this.partition;
  }

  get watermark(): number {
    return this.state.currentWatermarkMs;
  }
}

/**
 * Coordinates watermark state for event-time operators.
 *
 * Global watermark = min(maxTimestamp - outOfOrderness) over active,
 * initialised partitions.  Idle and not-yet-initialised partitions are
 * excluded.  The result is clamped to the previously emitted watermark so a
 * caller can never observe a regression.
 */
export class WatermarkCoordinator {
  private readonly states: Map<string, InternalPartition>;
  private config: ResolvedOptions;
  private currentWatermark: number;
  private lastTriggerSequence: number;
  private triggerHistory: WatermarkTrigger[];
  private readonly watermarkListeners: Set<WatermarkListener>;
  private readonly triggerListeners: Set<TriggerListener>;
  private lastObservation: ObservationResult | null;

  constructor(options: WatermarkOptions | WatermarkPolicy = {}) {
    const normalizedOptions: WatermarkOptions =
      options instanceof WatermarkPolicy ? { policy: options } : options;
    this.config = resolveOptions(normalizedOptions);
    this.states = new Map();
    this.currentWatermark = this.config.initialWatermark;
    this.lastTriggerSequence = 0;
    this.triggerHistory = [];
    this.watermarkListeners = new Set();
    this.triggerListeners = new Set();
    this.lastObservation = null;

    if (normalizedOptions.onWatermark) {
      this.onWatermark(normalizedOptions.onWatermark);
    }
    if (normalizedOptions.onTrigger) {
      this.onTrigger(normalizedOptions.onTrigger);
    }

    if (this.config.emitInitial && Number.isFinite(this.currentWatermark)) {
      this.emitTrigger("initial", undefined, undefined, undefined, -Infinity);
    }
  }

  /** Current monotonic global watermark. */
  get watermark(): number {
    return this.currentWatermark;
  }

  getWatermark(): number {
    return this.currentWatermark;
  }

  getGlobalWatermark(): number {
    return this.currentWatermark;
  }

  /** Nullable form used by the watermark-kit API. */
  globalWatermark(): number | null {
    return this.activePartitionCount() > 0 &&
      Number.isFinite(this.currentWatermark)
      ? this.currentWatermark
      : null;
  }

  global_watermark(): number | null {
    return this.globalWatermark();
  }

  get watermarkOrNull(): number | null {
    return this.globalWatermark();
  }

  getCurrentWatermark(): number {
    return this.currentWatermark;
  }

  getSequence(): number {
    return this.lastTriggerSequence;
  }

  getTriggerSequence(): number {
    return this.lastTriggerSequence;
  }

  get currentSequence(): number {
    return this.lastTriggerSequence;
  }

  getLastTrigger(): WatermarkTrigger | null {
    return this.triggerHistory.length === 0
      ? null
      : this.triggerHistory[this.triggerHistory.length - 1];
  }

  get lastTrigger(): WatermarkTrigger | null {
    return this.getLastTrigger();
  }

  getTriggers(): WatermarkTrigger[] {
    return this.triggerHistory.map((trigger) => ({ ...trigger }));
  }

  getTriggerHistory(): WatermarkTrigger[] {
    return this.getTriggers();
  }

  get watermarks(): number[] {
    return this.triggerHistory.map((trigger) => trigger.watermark);
  }

  get watermarkHistory(): number[] {
    return this.watermarks;
  }

  getWatermarkHistory(): number[] {
    return this.watermarks;
  }

  getConfig(): Readonly<ResolvedOptions> {
    return { ...this.config };
  }

  /** Policy view suitable for checkpoint metadata and policy-style callers. */
  get policy(): WatermarkPolicy {
    return new WatermarkPolicy(
      this.config.outOfOrderness,
      this.config.allowedLateness,
      this.config.idleTimeout ?? 0,
    );
  }

  get partitions(): PartitionWatermark[] {
    return Array.from(this.states.values(), (partition) => {
      const state = new WatermarkState({
        outOfOrderness: partition.outOfOrderness,
        allowedLateness: partition.allowedLateness,
        idleTimeout: this.config.idleTimeout ?? undefined,
      });
      state.maxEventTimeMs = partition.initialized
        ? partition.maxTimestamp
        : 0;
      state.currentWatermarkMs = partition.initialized
        ? partition.maxTimestamp - partition.outOfOrderness
        : 0;
      state.lastArrivalMs = partition.lastActivity;
      state.initialized = partition.initialized;
      return new PartitionWatermark(partition.id, state, partition.idle);
    });
  }

  get partitionWatermarks(): PartitionWatermark[] {
    return this.partitions;
  }

  /** Most recent observation result (also exposed through result getters). */
  get lastResult(): ObservationResult | null {
    return this.lastObservation;
  }

  get observation(): ObservationResult | null {
    return this.lastObservation;
  }

  get partitionId(): string | undefined {
    return this.lastObservation?.partitionId;
  }

  get timestamp(): number | undefined {
    return this.lastObservation?.timestamp;
  }

  get previousWatermark(): number | undefined {
    return this.lastObservation?.previousWatermark;
  }

  get partitionWatermark(): number {
    return this.lastObservation?.partitionWatermark ?? -Infinity;
  }

  get advanced(): boolean {
    return this.lastObservation?.advanced ?? false;
  }

  get emitted(): boolean {
    return this.lastObservation?.emitted ?? false;
  }

  get late(): boolean {
    return this.lastObservation?.late ?? false;
  }

  get isLate(): boolean {
    return this.lastObservation?.isLate ?? false;
  }

  get status(): EventStatus | null {
    return this.lastObservation?.status ?? null;
  }

  get eventStatus(): EventStatus | null {
    return this.lastObservation?.eventStatus ?? null;
  }

  get withinAllowedLateness(): boolean {
    return this.lastObservation?.withinAllowedLateness ?? true;
  }

  get tooLate(): boolean {
    return this.lastObservation?.tooLate ?? false;
  }

  get accepted(): boolean {
    return this.lastObservation?.accepted ?? true;
  }

  get reactivated(): boolean {
    return this.lastObservation?.reactivated ?? false;
  }

  get idle(): boolean {
    return this.lastObservation?.idle ?? false;
  }

  get idleGeneration(): number {
    return this.lastObservation?.idleGeneration ?? 0;
  }

  get eventCount(): number {
    return this.lastObservation?.eventCount ?? 0;
  }

  get lateEventCount(): number {
    return this.lastObservation?.lateEventCount ?? 0;
  }

  get sequence(): number | null {
    return this.lastObservation?.sequence ?? null;
  }

  get trigger(): WatermarkTrigger | null {
    return this.lastObservation?.trigger ?? null;
  }

  addPartition(
    id: PartitionId,
    options: PartitionOptions | number = {},
  ): PartitionState & this {
    const partitionId = normalizeId(id);
    const optionsObject: PartitionOptions =
      typeof options === "number" ? { outOfOrderness: options } : options;

    let partition = this.states.get(partitionId);
    if (partition) {
      if (optionsObject.outOfOrderness !== undefined ||
          optionsObject.maxOutOfOrderness !== undefined ||
          optionsObject.allowedOutOfOrderness !== undefined ||
          optionsObject.outOfOrderBound !== undefined ||
          optionsObject.maxLateness !== undefined) {
        partition.outOfOrderness = normalizeBound(
          outOfOrdernessOf(optionsObject),
          "outOfOrderness",
          this.config.outOfOrderness,
        );
      }
      if (optionsObject.allowedLateness !== undefined || optionsObject.lateness !== undefined) {
        partition.allowedLateness = normalizeBound(
          allowedLatenessOf(optionsObject),
          "allowedLateness",
          this.config.allowedLateness,
        );
      }
      if (!partition.initialized) {
        const initialTimestamp = firstDefined(
          optionsObject.initialTimestamp,
          optionsObject.maxTimestamp,
          optionsObject.timestamp,
        );
        if (initialTimestamp !== undefined) {
          partition.maxTimestamp = normalizeTimestamp(initialTimestamp, "initialTimestamp");
          partition.initialized = true;
        }
      }
      if (optionsObject.idle === true) {
        this.markIdleInternal(partition);
      } else if (optionsObject.idle === false) {
        this.reactivateInternal(partition);
      }
      this.advance("configuration", partitionId);
      return this.decoratePartitionResult(toPublicPartition(partition));
    }

    const initialTimestamp = firstDefined(
      optionsObject.initialTimestamp,
      optionsObject.maxTimestamp,
      optionsObject.timestamp,
    );
    partition = {
      id: partitionId,
      initialized: initialTimestamp !== undefined,
      maxTimestamp:
        initialTimestamp === undefined
          ? -Infinity
          : normalizeTimestamp(initialTimestamp, "initialTimestamp"),
      outOfOrderness: normalizeBound(
        outOfOrdernessOf(optionsObject),
        "outOfOrderness",
        this.config.outOfOrderness,
      ),
      allowedLateness: normalizeBound(
        allowedLatenessOf(optionsObject),
        "allowedLateness",
        this.config.allowedLateness,
      ),
      idle: optionsObject.idle === true,
      idleGeneration: optionsObject.idleGeneration ?? (optionsObject.idle === true ? 1 : 0),
      eventCount: 0,
      lateEventCount: 0,
      lastEventTimestamp: null,
      lastActivity: initialTimestamp === undefined
        ? 0
        : normalizeTimestamp(initialTimestamp, "initialTimestamp"),
    };
    if (!Number.isInteger(partition.idleGeneration) || partition.idleGeneration < 0) {
      throw new RangeError("idleGeneration must be a non-negative integer");
    }

    this.states.set(partitionId, partition);
    this.advance("partition-added", partitionId);
    return this.decoratePartitionResult(toPublicPartition(partition));
  }

  registerPartition(
    id: PartitionId,
    options: PartitionOptions | number = {},
  ): PartitionState & this {
    return this.addPartition(id, options);
  }

  createPartition(
    id: PartitionId,
    options: PartitionOptions | number = {},
  ): PartitionState & this {
    return this.addPartition(id, options);
  }

  hasPartition(id: PartitionId): boolean {
    return this.states.has(normalizeId(id));
  }

  getPartition(id: PartitionId): PartitionState | null {
    const partition = this.states.get(normalizeId(id));
    return partition ? toPublicPartition(partition) : null;
  }

  getPartitionState(id: PartitionId): PartitionState | null {
    return this.getPartition(id);
  }

  getPartitions(): PartitionState[] {
    return Array.from(this.states.values(), toPublicPartition);
  }

  getPartitionStates(): PartitionState[] {
    return this.getPartitions();
  }

  getPartitionIds(): string[] {
    return Array.from(this.states.keys());
  }

  getPartitionCount(): number {
    return this.states.size;
  }

  get partitionCount(): number {
    return this.states.size;
  }

  get size(): number {
    return this.states.size;
  }

  getPartitionWatermark(id: PartitionId): number {
    const partition = this.states.get(normalizeId(id));
    if (!partition || !partition.initialized) {
      return -Infinity;
    }
    return partition.maxTimestamp - partition.outOfOrderness;
  }

  getPartitionMaxTimestamp(id: PartitionId): number | null {
    const partition = this.states.get(normalizeId(id));
    return partition && partition.initialized ? partition.maxTimestamp : null;
  }

  getIdleGeneration(id: PartitionId): number | null {
    return this.states.get(normalizeId(id))?.idleGeneration ?? null;
  }

  setOutOfOrderness(id: PartitionId, bound: number): PartitionState & this {
    const partition = this.requirePartition(id);
    partition.outOfOrderness = normalizeBound(bound, "outOfOrderness", 0);
    this.advance("configuration", partition.id);
    return this.decoratePartitionResult(toPublicPartition(partition));
  }

  setAllowedLateness(id: PartitionId, lateness: number): PartitionState & this {
    const partition = this.requirePartition(id);
    partition.allowedLateness = normalizeBound(lateness, "allowedLateness", 0);
    return this.decoratePartitionResult(toPublicPartition(partition));
  }

  removePartition(id: PartitionId): boolean {
    const partitionId = normalizeId(id);
    const removed = this.states.delete(partitionId);
    if (removed) {
      this.advance("partition-removed", partitionId);
    }
    return removed;
  }

  dropPartition(id: PartitionId): boolean {
    return this.removePartition(id);
  }

  deletePartition(id: PartitionId): boolean {
    return this.removePartition(id);
  }

  markIdle(id: PartitionId): PartitionState & this {
    const partition = this.requirePartition(id);
    this.markIdleInternal(partition);
    this.advance("idle", partition.id, undefined, partition.idleGeneration);
    return this.decoratePartitionResult(toPublicPartition(partition));
  }

  markPartitionIdle(id: PartitionId): PartitionState & this {
    return this.markIdle(id);
  }

  setIdle(id: PartitionId, idle = true): PartitionState & this {
    return idle ? this.markIdle(id) : this.reactivate(id);
  }

  reactivate(id: PartitionId): PartitionState & this {
    const partition = this.requirePartition(id);
    this.reactivateInternal(partition);
    this.advance("reactivate", partition.id, undefined, partition.idleGeneration);
    return this.decoratePartitionResult(toPublicPartition(partition));
  }

  reactivatePartition(id: PartitionId): PartitionState & this {
    return this.reactivate(id);
  }

  activatePartition(id: PartitionId): PartitionState & this {
    return this.reactivate(id);
  }

  markActive(id: PartitionId): PartitionState & this {
    return this.reactivate(id);
  }

  activate(id: PartitionId): PartitionState & this {
    return this.reactivate(id);
  }

  resume(id: PartitionId): PartitionState & this {
    return this.reactivate(id);
  }

  wake(id: PartitionId): PartitionState & this {
    return this.reactivate(id);
  }

  /**
   * Record one event and return the resulting watermark state.
   *
   * `observe(partitionId, timestamp)` and
   * `observe({ partitionId, timestamp })` are both supported.  Receiving an
   * event for an idle partition reactivates it automatically.
   */
  observe(
    partitionOrEvent: PartitionId | EventInput,
    timestamp?: TimestampInput,
    options?: EventOptions | number,
  ): ObservationResult & this;
  observe(
    partitionId: PartitionId,
    event: StreamEvent | StreamEventInput | EventInput,
    options?: EventOptions | number,
  ): ObservationResult & this;
  observe(
    partitionOrEvent: PartitionId | EventInput | StreamEvent,
    timestamp?: TimestampInput | StreamEventInput | EventInput | StreamEvent,
    options: EventOptions | number = {},
  ): ObservationResult & this {
    let partitionId: PartitionId;
    let eventTimestamp: TimestampInput;
    let eventOptions: EventOptions;
    let arrivalTime: number | undefined;

    if (typeof partitionOrEvent === "object" && partitionOrEvent !== null &&
        !(partitionOrEvent instanceof Date)) {
      const event = partitionOrEvent as EventInput & StreamEventInput;
      const id = firstDefined(
        event.partitionId,
        event.partition,
        event.key,
        event.id,
      );
      if (id === undefined) {
        throw new TypeError("event object must contain partitionId, partition, key, or id");
      }
      partitionId = id;
      eventTimestamp = eventTimeOf(event);
      arrivalTime = arrivalTimeOf(event, normalizeTimestamp(eventTimestamp, "eventTime"));
      eventOptions = event;
    } else {
      if (timestamp === undefined) {
        throw new TypeError("timestamp is required");
      }
      partitionId = partitionOrEvent as PartitionId;
      if (typeof timestamp === "object" && !(timestamp instanceof Date)) {
        const event = timestamp as StreamEventInput & EventInput;
        eventTimestamp = eventTimeOf(event);
        arrivalTime = arrivalTimeOf(
          event,
          normalizeTimestamp(eventTimestamp, "eventTime"),
        );
        eventOptions =
          typeof options === "number" ? { outOfOrderness: options } : event;
      } else {
        eventTimestamp = timestamp as TimestampInput;
        eventOptions =
          typeof options === "number" ? { outOfOrderness: options } : options;
      }
    }

    const result = this.observeInternal(
      partitionId,
      eventTimestamp,
      eventOptions,
      arrivalTime,
    );
    this.lastObservation = result;
    return this as ObservationResult & this;
  }

  recordEvent(
    partitionOrEvent: PartitionId | EventInput,
    timestamp?: TimestampInput | StreamEventInput | EventInput,
    options: EventOptions | number = {},
  ): ObservationResult & this {
    return this.observe(
      partitionOrEvent as PartitionId | EventInput,
      timestamp as TimestampInput,
      options,
    );
  }

  processEvent(
    partitionOrEvent: PartitionId | EventInput,
    timestamp?: TimestampInput | StreamEventInput | EventInput,
    options: EventOptions | number = {},
  ): ObservationResult & this {
    return this.observe(
      partitionOrEvent as PartitionId | EventInput,
      timestamp as TimestampInput,
      options,
    );
  }

  ingestEvent(
    partitionOrEvent: PartitionId | EventInput,
    timestamp?: TimestampInput | StreamEventInput | EventInput,
    options: EventOptions | number = {},
  ): ObservationResult & this {
    return this.observe(
      partitionOrEvent as PartitionId | EventInput,
      timestamp as TimestampInput,
      options,
    );
  }

  observeEvent(
    partitionOrEvent: PartitionId | EventInput,
    timestamp?: TimestampInput | StreamEventInput | EventInput,
    options: EventOptions | number = {},
  ): ObservationResult & this {
    return this.observe(
      partitionOrEvent as PartitionId | EventInput,
      timestamp as TimestampInput,
      options,
    );
  }

  trackEvent(
    partitionOrEvent: PartitionId | EventInput,
    timestamp?: TimestampInput | StreamEventInput | EventInput,
    options: EventOptions | number = {},
  ): ObservationResult & this {
    return this.observe(
      partitionOrEvent as PartitionId | EventInput,
      timestamp as TimestampInput,
      options,
    );
  }

  updatePartition(
    partitionOrEvent: PartitionId | EventInput,
    timestamp?: TimestampInput | StreamEventInput | EventInput,
    options: EventOptions | number = {},
  ): ObservationResult & this {
    return this.observe(
      partitionOrEvent as PartitionId | EventInput,
      timestamp as TimestampInput,
      options,
    );
  }

  advance(
    partitionOrEvent: PartitionId | EventInput,
    timestamp?: TimestampInput,
    options?: EventOptions | number,
  ): ObservationResult & this;
  advance(
    reason: WatermarkTriggerReason,
    partitionId?: string,
    eventTimestamp?: number,
    idleGeneration?: number,
  ): WatermarkTrigger | null;
  advance(
    partitionOrEvent: PartitionId | EventInput | WatermarkTriggerReason,
    timestamp?: TimestampInput | string | number,
    options: EventOptions | number = {},
    idleGeneration?: number,
  ): ObservationResult | WatermarkTrigger | null {
    if (
      partitionOrEvent === "event" ||
      partitionOrEvent === "idle" ||
      partitionOrEvent === "reactivate" ||
      partitionOrEvent === "partition-added" ||
      partitionOrEvent === "partition-removed" ||
      partitionOrEvent === "configuration" ||
      partitionOrEvent === "restore" ||
      partitionOrEvent === "initial"
    ) {
      return this.advanceInternal(
        partitionOrEvent,
        typeof timestamp === "string" ? timestamp : undefined,
        typeof timestamp === "number" ? timestamp : undefined,
        idleGeneration,
      );
    }
    return this.observe(
      partitionOrEvent,
      timestamp as TimestampInput | undefined,
      options,
    );
  }

  advanceWatermark(
    partitionId: PartitionId,
    timestamp: TimestampInput,
    options: EventOptions | number = {},
  ): ObservationResult & this {
    return this.observe(partitionId, timestamp, options);
  }

  updatePartitionWatermark(
    partitionId: PartitionId,
    timestamp: TimestampInput,
    options: EventOptions | number = {},
  ): ObservationResult & this {
    return this.observe(partitionId, timestamp, options);
  }

  onWatermark(listener: WatermarkListener): () => void {
    if (typeof listener !== "function") {
      throw new TypeError("listener must be a function");
    }
    this.watermarkListeners.add(listener);
    return () => {
      this.watermarkListeners.delete(listener);
    };
  }

  subscribe(listener: WatermarkListener): () => void {
    return this.onWatermark(listener);
  }

  addListener(listener: WatermarkListener): () => void {
    return this.onWatermark(listener);
  }

  offWatermark(listener: WatermarkListener): void {
    this.watermarkListeners.delete(listener);
  }

  onTrigger(listener: TriggerListener): () => void {
    if (typeof listener !== "function") {
      throw new TypeError("listener must be a function");
    }
    this.triggerListeners.add(listener);
    return () => {
      this.triggerListeners.delete(listener);
    };
  }

  offTrigger(listener: TriggerListener): void {
    this.triggerListeners.delete(listener);
  }

  /**
   * Mark partitions idle whose last activity is older than idleTimeout.
   * This is explicit so the coordinator never owns a timer.
   */
  tick(now: number = Date.now()): string[] {
    if (this.config.idleTimeout === null) {
      return [];
    }
    const idled: string[] = [];
    for (const partition of this.states.values()) {
      if (
        !partition.idle &&
        partition.initialized &&
        now - partition.lastActivity >= this.config.idleTimeout
      ) {
        this.markIdleInternal(partition);
        idled.push(partition.id);
      }
    }
    if (idled.length > 0) {
      this.advance("idle");
    }
    return idled;
  }

  refreshIdle(nowMs: number = Date.now()): this {
    this.tick(nowMs);
    return this;
  }

  refresh_idle(nowMs: number = Date.now()): this {
    return this.refreshIdle(nowMs);
  }

  activePartitionCount(): number {
    let count = 0;
    for (const partition of this.states.values()) {
      if (!partition.idle && partition.initialized) {
        count += 1;
      }
    }
    return count;
  }

  getActivePartitionCount(): number {
    return this.activePartitionCount();
  }

  active_partition_count(): number {
    return this.activePartitionCount();
  }

  partitionWatermarkOf(id: PartitionId): number | null {
    const watermark = this.getPartitionWatermark(id);
    return Number.isFinite(watermark) ? watermark : null;
  }

  getPartitionWatermarkOrNull(id: PartitionId): number | null {
    return this.partitionWatermarkOf(id);
  }

  partition_watermark(id: PartitionId): number | null {
    return this.partitionWatermarkOf(id);
  }

  snapshot(): WatermarkSnapshot {
    const partitions: Record<string, SnapshotPartition> = {};
    const ids = Array.from(this.states.keys());
    for (const id of ids) {
      const partition = this.states.get(id) as InternalPartition;
      partitions[id] = {
        id: partition.id,
        maxTimestamp: partition.initialized ? partition.maxTimestamp : null,
        outOfOrderness: partition.outOfOrderness,
        allowedLateness: partition.allowedLateness,
        idle: partition.idle,
        idleGeneration: partition.idleGeneration,
        eventCount: partition.eventCount,
        lateEventCount: partition.lateEventCount,
        lastEventTimestamp: partition.lastEventTimestamp,
        lastActivity: partition.lastActivity,
        initialized: partition.initialized,
      };
    }

    return {
      version: 1,
      watermark: finiteOrNull(this.currentWatermark),
      sequence: this.lastTriggerSequence,
      config: {
        outOfOrderness: this.config.outOfOrderness,
        allowedLateness: this.config.allowedLateness,
        idleTimeout: this.config.idleTimeout,
        advanceWhenAllIdle: this.config.advanceWhenAllIdle,
      },
      partitions,
      triggers: this.getTriggers(),
    };
  }

  checkpoint(): WatermarkSnapshot {
    return this.snapshot();
  }

  createCheckpoint(): WatermarkSnapshot {
    return this.snapshot();
  }

  toJSON(): WatermarkSnapshot {
    return this.snapshot();
  }

  serialize(): string {
    return JSON.stringify(this.snapshot());
  }

  restore(
    snapshot: WatermarkSnapshotInput,
    options: RestoreOptions = {},
  ): this {
    const parsed: unknown =
      typeof snapshot === "string" ? JSON.parse(snapshot) : snapshot;
    if (typeof parsed !== "object" || parsed === null) {
      throw new TypeError("snapshot must be an object or JSON string");
    }
    const source = parsed as Partial<WatermarkSnapshot> & {
      lastSequence?: number;
      triggerSequence?: number;
      currentWatermark?: number | null;
      global_watermark?: number | null;
      globalWatermark?: number;
      partitionStates?: unknown;
      states?: unknown;
      sources?: unknown;
      partitionWatermarks?: unknown;
    };

    if (source.version !== undefined && source.version !== 1) {
      throw new Error(`unsupported watermark snapshot version: ${String(source.version)}`);
    }

    const configSource = source.config;
    if (!options.preserveConfig && configSource) {
      this.config = {
        ...this.config,
        outOfOrderness: normalizeBound(
          configSource.outOfOrderness,
          "outOfOrderness",
          this.config.outOfOrderness,
        ),
        allowedLateness: normalizeBound(
          configSource.allowedLateness,
          "allowedLateness",
          this.config.allowedLateness,
        ),
        idleTimeout:
          configSource.idleTimeout === undefined
            ? this.config.idleTimeout
            : configSource.idleTimeout === null
              ? null
              : normalizeTimeout(configSource.idleTimeout, this.config.idleTimeout),
        advanceWhenAllIdle:
          configSource.advanceWhenAllIdle === undefined
            ? this.config.advanceWhenAllIdle
            : configSource.advanceWhenAllIdle === true,
      };
    }

    const restored = new Map<string, InternalPartition>();
    const partitionsSource =
      source.partitions ??
      source.partitionStates ??
      source.states ??
      source.sources ??
      source.partitionWatermarks ??
      {};
    const entries: Array<[string, unknown]> = Array.isArray(partitionsSource)
      ? partitionsSource.map((entry, index) => {
          const object = entry as Partial<SnapshotPartition>;
          return [object.id ?? String(index), entry];
        })
      : Object.entries(partitionsSource as Record<string, unknown>);

    for (const [key, value] of entries) {
      if (typeof value !== "object" || value === null) {
        continue;
      }
      const raw = value as Partial<SnapshotPartition> & {
        partition?: string;
        name?: string;
        maxEventTime?: number | null;
        maxEventTimeMs?: number | null;
        max_event_time_ms?: number | null;
        generation?: number;
        maxOutOfOrderness?: number;
        maxOutOfOrderMs?: number;
        allowedLatenessMs?: number;
        lastArrival?: number;
      };
      const id = normalizeId(raw.id ?? raw.partition ?? raw.name ?? key);
      const maxTimestamp = numberOrNegativeInfinity(
        firstDefined(
          raw.maxTimestamp,
          raw.maxEventTime,
          raw.maxEventTimeMs,
          raw.max_event_time_ms,
        ),
      );
      const initialized =
        Number.isFinite(maxTimestamp) && raw.initialized !== false;
      const idleGeneration = raw.idleGeneration ?? raw.generation ?? 0;
      if (!Number.isInteger(idleGeneration) || idleGeneration < 0) {
        throw new RangeError("snapshot idleGeneration must be a non-negative integer");
      }

      restored.set(id, {
        id,
        initialized,
        maxTimestamp: initialized ? maxTimestamp : -Infinity,
        outOfOrderness: normalizeBound(
          firstDefined(
            raw.outOfOrderness,
            raw.maxOutOfOrderness,
            raw.maxOutOfOrderMs,
          ),
          "outOfOrderness",
          this.config.outOfOrderness,
        ),
        allowedLateness: normalizeBound(
          firstDefined(raw.allowedLateness, raw.allowedLatenessMs),
          "allowedLateness",
          this.config.allowedLateness,
        ),
        idle: raw.idle === true,
        idleGeneration,
        eventCount:
          typeof raw.eventCount === "number" && raw.eventCount >= 0
            ? Math.floor(raw.eventCount)
            : 0,
        lateEventCount:
          typeof raw.lateEventCount === "number" && raw.lateEventCount >= 0
            ? Math.floor(raw.lateEventCount)
            : 0,
        lastEventTimestamp:
          raw.lastEventTimestamp === null || raw.lastEventTimestamp === undefined
            ? null
            : numberOrNegativeInfinity(raw.lastEventTimestamp),
        lastActivity:
          firstDefined(raw.lastActivity, raw.lastArrival) === undefined
            ? 0
            : normalizeTimestamp(
              firstDefined(raw.lastActivity, raw.lastArrival),
              "lastActivity",
            ),
      });
    }

    this.states.clear();
    for (const [id, partition] of restored) {
      this.states.set(id, partition);
    }

    const snapshotWatermark = numberOrNegativeInfinity(
      firstDefined(
        source.watermark,
        source.globalWatermark,
        source.global_watermark,
        source.currentWatermark,
      ),
    );
    const snapshotSequence =
      firstDefined(source.sequence, source.lastSequence, source.triggerSequence) ?? 0;
    let restoredSequence =
      Number.isFinite(snapshotSequence) ? Math.floor(snapshotSequence) : 0;

    if (Array.isArray(source.triggers)) {
      this.triggerHistory = source.triggers
        .filter((trigger): trigger is WatermarkTrigger =>
          typeof trigger === "object" && trigger !== null &&
          typeof (trigger as WatermarkTrigger).watermark === "number",
        )
        .map((trigger, index) => {
          const watermark = numberOrNegativeInfinity(trigger.watermark);
          const sequence =
            typeof trigger.sequence === "number"
              ? trigger.sequence
              : index + 1;
          const reason = trigger.reason ?? trigger.type ?? "restore";
          restoredSequence = Math.max(restoredSequence, sequence);
          return {
            ...trigger,
            sequence,
            seq: sequence,
            watermark,
            globalWatermark: watermark,
            previousWatermark: numberOrNegativeInfinity(
              trigger.previousWatermark,
            ),
            reason,
            type: reason,
          };
        });
    }

    this.lastTriggerSequence = Math.max(
      this.lastTriggerSequence,
      restoredSequence,
    );

    const candidate = this.computeCandidate();
    const target = Math.max(
      this.currentWatermark,
      snapshotWatermark,
      candidate ?? -Infinity,
    );

    if (target > this.currentWatermark) {
      const previous = this.currentWatermark;
      this.currentWatermark = target;
      if (options.emit === true) {
        this.emitTrigger("restore", undefined, undefined, undefined, previous);
      }
    } else {
      this.currentWatermark = target;
    }

    return this;
  }

  restoreSnapshot(
    snapshot: WatermarkSnapshotInput,
    options: RestoreOptions = {},
  ): this {
    return this.restore(snapshot, options);
  }

  restoreCheckpoint(
    snapshot: WatermarkSnapshotInput,
    options: RestoreOptions = {},
  ): this {
    return this.restore(snapshot, options);
  }

  loadCheckpoint(
    snapshot: WatermarkSnapshotInput,
    options: RestoreOptions = {},
  ): this {
    return this.restore(snapshot, options);
  }

  clone(): WatermarkCoordinator {
    const clone = new WatermarkCoordinator({
      outOfOrderness: this.config.outOfOrderness,
      allowedLateness: this.config.allowedLateness,
      idleTimeout: this.config.idleTimeout ?? undefined,
      initialWatermark: this.currentWatermark,
      advanceWhenAllIdle: this.config.advanceWhenAllIdle,
    });
    clone.restore(this.snapshot(), { preserveConfig: true });
    return clone;
  }

  static fromSnapshot(
    snapshot: WatermarkSnapshotInput,
    options: RestoreOptions = {},
  ): WatermarkCoordinator {
    return new WatermarkCoordinator().restore(snapshot, options);
  }

  static deserialize(
    serialized: string,
    options: RestoreOptions = {},
  ): WatermarkCoordinator {
    return WatermarkCoordinator.fromSnapshot(serialized, options);
  }

  static new(
    options: WatermarkOptions | WatermarkPolicy = {},
  ): WatermarkCoordinator {
    return new WatermarkCoordinator(options);
  }

  private decoratePartitionResult(
    state: PartitionState,
  ): PartitionState & this {
    const methods = [
      "addPartition",
      "removePartition",
      "observe",
      "recordEvent",
      "processEvent",
      "updatePartition",
      "advanceWatermark",
      "markIdle",
      "reactivate",
      "setOutOfOrderness",
      "setAllowedLateness",
      "snapshot",
      "checkpoint",
      "restore",
      "getWatermark",
      "globalWatermark",
      "activePartitionCount",
      "refreshIdle",
      "getTriggers",
      "getSequence",
    ] as const;

    for (const name of methods) {
      Object.defineProperty(state, name, {
        value: (this[name] as (...args: unknown[]) => unknown).bind(this),
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
    return state as PartitionState & this;
  }

  private observeInternal(
    id: PartitionId,
    timestampInput: TimestampInput,
    options: EventOptions,
    arrivalTime?: number,
  ): ObservationResult {
    const partitionId = normalizeId(id);
    const timestamp = normalizeTimestamp(timestampInput, "timestamp");
    const previousWatermark = this.currentWatermark;

    let partition = this.states.get(partitionId);
    if (!partition) {
      this.addPartition(partitionId, {
        outOfOrderness: outOfOrdernessOf(options),
        allowedLateness: allowedLatenessOf(options),
      });
      partition = this.states.get(partitionId) as InternalPartition;
    }

    const overriddenOutOfOrderness = outOfOrdernessOf(options);
    if (overriddenOutOfOrderness !== undefined) {
      partition.outOfOrderness = normalizeBound(
        overriddenOutOfOrderness,
        "outOfOrderness",
        partition.outOfOrderness,
      );
    }
    const overriddenLateness = allowedLatenessOf(options);
    if (overriddenLateness !== undefined) {
      partition.allowedLateness = normalizeBound(
        overriddenLateness,
        "allowedLateness",
        partition.allowedLateness,
      );
    }

    const reactivated = partition.idle;
    if (reactivated) {
      this.reactivateInternal(partition);
    }

    const hasWatermark = this.currentWatermark !== -Infinity;
    const late = hasWatermark && timestamp < this.currentWatermark;
    const withinAllowedLateness =
      !late || timestamp >= this.currentWatermark - partition.allowedLateness;
    const tooLate = late && !withinAllowedLateness;
    const status: EventStatus = !late
      ? EventStatus.OnTime
      : tooLate
        ? EventStatus.TooLate
        : EventStatus.Late;

    if (!partition.initialized) {
      partition.maxTimestamp = timestamp;
      partition.initialized = true;
    } else {
      partition.maxTimestamp = Math.max(partition.maxTimestamp, timestamp);
    }

    partition.eventCount += 1;
    if (late) {
      partition.lateEventCount += 1;
    }
    partition.lastEventTimestamp = timestamp;
    partition.lastActivity = arrivalTime ?? timestamp;

    const trigger = this.advanceInternal(
      "event",
      partition.id,
      timestamp,
      reactivated ? partition.idleGeneration : undefined,
    );
    const partitionWatermark = partition.maxTimestamp - partition.outOfOrderness;

    return {
      partitionId: partition.id,
      timestamp,
      watermark: this.currentWatermark,
      globalWatermark: this.currentWatermark,
      previousWatermark,
      partitionWatermark,
      advanced: trigger !== null,
      emitted: trigger !== null,
      late,
      isLate: late,
      status,
      eventStatus: status,
      withinAllowedLateness,
      tooLate,
      accepted: !tooLate,
      reactivated,
      idle: partition.idle,
      idleGeneration: partition.idleGeneration,
      eventCount: partition.eventCount,
      lateEventCount: partition.lateEventCount,
      sequence: trigger ? trigger.sequence : null,
      trigger,
    };
  }

  private requirePartition(id: PartitionId): InternalPartition {
    const partitionId = normalizeId(id);
    let partition = this.states.get(partitionId);
    if (!partition) {
      this.addPartition(partitionId);
      partition = this.states.get(partitionId) as InternalPartition;
    }
    return partition;
  }

  private markIdleInternal(partition: InternalPartition): void {
    if (partition.idle) {
      return;
    }
    partition.idle = true;
    partition.idleGeneration += 1;
  }

  private reactivateInternal(partition: InternalPartition): void {
    if (!partition.idle) {
      return;
    }
    partition.idle = false;
  }

  private computeCandidate(): number | undefined {
    let minimum = Number.POSITIVE_INFINITY;
    let found = false;

    for (const partition of this.states.values()) {
      if (!partition.initialized || partition.idle) {
        continue;
      }
      const localWatermark = partition.maxTimestamp - partition.outOfOrderness;
      // A partition that is already behind an emitted watermark cannot be
      // allowed to block future progress.
      const effective =
        localWatermark < this.currentWatermark
          ? this.currentWatermark
          : localWatermark;
      if (!found || effective < minimum) {
        minimum = effective;
        found = true;
      }
    }

    if (found) {
      return minimum;
    }

    if (this.config.advanceWhenAllIdle) {
      let maximum = -Infinity;
      let anyIdle = false;
      for (const partition of this.states.values()) {
        if (!partition.initialized || !partition.idle) {
          continue;
        }
        maximum = Math.max(
          maximum,
          partition.maxTimestamp - partition.outOfOrderness,
        );
        anyIdle = true;
      }
      if (anyIdle) {
        return maximum;
      }
    }

    return undefined;
  }

  private advanceInternal(
    reason: WatermarkTriggerReason,
    partitionId?: string,
    eventTimestamp?: number,
    idleGeneration?: number,
  ): WatermarkTrigger | null {
    const candidate = this.computeCandidate();
    if (candidate === undefined || !(candidate > this.currentWatermark)) {
      return null;
    }
    return this.emitTrigger(
      reason,
      partitionId,
      eventTimestamp,
      idleGeneration,
      this.currentWatermark,
    );
  }

  private emitTrigger(
    reason: WatermarkTriggerReason,
    partitionId: string | undefined,
    eventTimestamp: number | undefined,
    idleGeneration: number | undefined,
    previousWatermark: number,
  ): WatermarkTrigger {
    // advanceInternal only calls this when the candidate is greater, but the
    // constructor/restore path passes the already-updated value.
    const candidate = this.computeCandidate();
    if (candidate !== undefined && candidate > this.currentWatermark) {
      this.currentWatermark = candidate;
    }

    this.lastTriggerSequence += 1;
    const trigger: WatermarkTrigger = {
      sequence: this.lastTriggerSequence,
      seq: this.lastTriggerSequence,
      watermark: this.currentWatermark,
      globalWatermark: this.currentWatermark,
      previousWatermark,
      reason,
      type: reason,
      partitionId,
      eventTimestamp,
      idleGeneration,
    };

    this.triggerHistory.push(trigger);
    if (
      Number.isFinite(this.config.maxTriggerHistory) &&
      this.triggerHistory.length > this.config.maxTriggerHistory
    ) {
      this.triggerHistory.splice(
        0,
        this.triggerHistory.length - this.config.maxTriggerHistory,
      );
    }

    for (const listener of this.watermarkListeners) {
      listener(trigger.watermark, trigger);
    }
    for (const listener of this.triggerListeners) {
      listener(trigger);
    }

    return trigger;
  }
}

export {
  WatermarkCoordinator as WatermarkTracker,
  WatermarkCoordinator as WatermarkManager,
  WatermarkCoordinator as WatermarkGenerator,
  WatermarkCoordinator as PartitionWatermarkTracker,
  WatermarkCoordinator as EventTimeWatermark,
  WatermarkCoordinator as EventTimeOperator,
  WatermarkCoordinator as EventTimeWatermarkCoordinator,
  WatermarkCoordinator as WatermarkKit,
  WatermarkCoordinator as Watermark,
};

export function createWatermarkCoordinator(
  options: WatermarkOptions | WatermarkPolicy = {},
): WatermarkCoordinator {
  return new WatermarkCoordinator(options);
}

export function createWatermarkTracker(
  options: WatermarkOptions | WatermarkPolicy = {},
): WatermarkCoordinator {
  return new WatermarkCoordinator(options);
}

export function createWatermark(
  options: WatermarkOptions | WatermarkPolicy = {},
): WatermarkCoordinator {
  return new WatermarkCoordinator(options);
}

export function createWatermarkManager(
  options: WatermarkOptions | WatermarkPolicy = {},
): WatermarkCoordinator {
  return new WatermarkCoordinator(options);
}

export function createEventTimeOperator(
  options: WatermarkOptions | WatermarkPolicy = {},
): WatermarkCoordinator {
  return new WatermarkCoordinator(options);
}

export default WatermarkCoordinator;
