import { type Clock, systemClock } from "./clock.ts";

export type ModelVersion = string | number;
export type InputShape =
  | string
  | readonly (number | null)[]
  | Readonly<Record<string, unknown>>;

export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(
    type: "abort",
    listener: () => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

export interface BatchRequest<T = unknown> {
  id: string;
  modelVersion?: ModelVersion;
  inputShape: InputShape;
  /** Absolute time on the scheduler's clock. */
  deadline: number;
  payload?: T;
  signal?: AbortSignalLike;
}

export interface ScheduledRequest<T = unknown> {
  readonly id: string;
  readonly modelVersion: ModelVersion;
  readonly inputShape: InputShape;
  readonly deadline: number;
  readonly payload: T | undefined;
  readonly signal: AbortSignalLike | undefined;
  readonly enqueuedAt: number;
}

export type BatchTrigger =
  | "batch-full"
  | "wait-expired"
  | "deadline"
  | "flush"
  | "version-switch";

export interface Batch<T = unknown> {
  readonly id: string;
  readonly key: string;
  readonly modelVersion: ModelVersion;
  readonly inputShape: InputShape;
  readonly requests: readonly ScheduledRequest<T>[];
  readonly size: number;
  readonly openedAt: number;
  readonly dispatchedAt: number;
  readonly deadline: number;
  readonly trigger: BatchTrigger;
}

export type BatchHandler<T = unknown, R = unknown> = (
  batch: Batch<T>,
) => R | readonly R[] | ReadonlyMap<string, R> | Promise<R | readonly R[] | ReadonlyMap<string, R>>;

export interface BatchSchedulerOptions<T = unknown, R = unknown> {
  maxBatchSize?: number;
  maxBatch?: number;
  batchSize?: number;
  maxWaitMs?: number;
  maxWait?: number;
  maxQueueWaitMs?: number;
  batchWindowMs?: number;
  clock?: Clock;
  handler?: BatchHandler<T, R>;
  onBatch?: BatchHandler<T, R>;
  executeBatch?: BatchHandler<T, R>;
  defaultModelVersion?: ModelVersion;
  modelVersion?: ModelVersion;
}

export interface SwitchVersionOptions {
  /**
   * Flush every already-queued cohort before changing the active version.
   * Defaults to true, so requests submitted after the switch cannot join an
   * old cohort.
   */
  flushPending?: boolean;
  /** Reject later submissions that explicitly target a retired version. */
  rejectRetiredVersions?: boolean;
}

export interface BatchSchedulerStats {
  readonly pendingRequests: number;
  readonly pendingBatches: number;
  readonly inFlightBatches: number;
  readonly dispatchedBatches: number;
  readonly timedOutRequests: number;
  readonly cancelledRequests: number;
  readonly activeVersion: ModelVersion | undefined;
}

export class BatchSchedulerError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class RequestCancelledError extends BatchSchedulerError {
  readonly requestId: string;

  constructor(requestId: string, reason?: unknown) {
    const suffix = reason === undefined ? "" : `: ${String(reason)}`;
    super(`Request "${requestId}" was cancelled before dispatch${suffix}`, "REQUEST_CANCELLED");
    this.requestId = requestId;
  }
}

export class RequestTimeoutError extends BatchSchedulerError {
  readonly requestId: string;
  readonly deadline: number;
  readonly timedOutAt: number;

  constructor(requestId: string, deadline: number, timedOutAt: number) {
    super(
      `Request "${requestId}" could not be dispatched by its deadline ${deadline}`,
      "REQUEST_TIMEOUT",
    );
    this.requestId = requestId;
    this.deadline = deadline;
    this.timedOutAt = timedOutAt;
  }
}

export class DuplicateRequestError extends BatchSchedulerError {
  readonly requestId: string;

  constructor(requestId: string) {
    super(`Request "${requestId}" is already pending`, "DUPLICATE_REQUEST");
    this.requestId = requestId;
  }
}

export class StaleModelVersionError extends BatchSchedulerError {
  readonly modelVersion: ModelVersion;

  constructor(modelVersion: ModelVersion) {
    super(`Model version "${String(modelVersion)}" has been retired`, "STALE_VERSION");
    this.modelVersion = modelVersion;
  }
}

export class SchedulerClosedError extends BatchSchedulerError {
  constructor() {
    super("Batch scheduler is closed", "SCHEDULER_CLOSED");
  }
}

interface PendingRequest<T, R> {
  view: ScheduledRequest<T>;
  key: string;
  resolve: (value: R) => void;
  reject: (reason: unknown) => void;
  abortListener: (() => void) | undefined;
  state: "pending" | "dispatched" | "cancelled" | "timed-out";
}

interface PendingBucket<T, R> {
  key: string;
  modelVersion: ModelVersion;
  inputShape: InputShape;
  requests: PendingRequest<T, R>[];
  openedAt: number;
}

const DEFAULT_MAX_BATCH_SIZE = 32;
const DEFAULT_MAX_WAIT_MS = 10;

function versionKey(version: ModelVersion): string {
  return `${typeof version}:${String(version)}`;
}

function stableValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableValue).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${stableValue(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function shapeKey(shape: InputShape): string {
  if (typeof shape === "string") {
    return `text:${shape}`;
  }
  return `value:${stableValue(shape)}`;
}

function copyShape(shape: InputShape): InputShape {
  if (Array.isArray(shape)) {
    return Object.freeze([...shape]) as InputShape;
  }
  if (typeof shape === "object" && shape !== null) {
    return Object.freeze({ ...shape }) as InputShape;
  }
  return shape;
}

function sameVersion(left: ModelVersion, right: ModelVersion): boolean {
  return versionKey(left) === versionKey(right);
}

export function areRequestsCompatible<T>(
  left: Pick<BatchRequest<T>, "modelVersion" | "inputShape">,
  right: Pick<BatchRequest<T>, "modelVersion" | "inputShape">,
): boolean {
  const versionsMatch =
    left.modelVersion === undefined || right.modelVersion === undefined
      ? left.modelVersion === right.modelVersion
      : sameVersion(left.modelVersion, right.modelVersion);
  return versionsMatch && shapeKey(left.inputShape) === shapeKey(right.inputShape);
}

export function areBatchRequestsCompatible<T>(
  left: ScheduledRequest<T>,
  right: ScheduledRequest<T>,
): boolean {
  return areRequestsCompatible(left, right);
}

function resultForRequest<R>(
  output: R | readonly R[] | ReadonlyMap<string, R> | undefined,
  request: ScheduledRequest<unknown>,
  index: number,
  count: number,
): R {
  if (output instanceof Map) {
    if (output.has(request.id)) {
      return output.get(request.id) as R;
    }
    return output.get(String(index)) as R;
  }
  if (Array.isArray(output) && output.length === count) {
    return output[index] as R;
  }
  return output as R;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return resolved;
}

function nonNegativeNumber(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return resolved;
}

/**
 * Deadline-aware, version- and shape-partitioned request batcher.
 *
 * A cohort is dispatched when it reaches `maxBatchSize`, when its oldest
 * request has waited for `maxWaitMs`, or when its earliest deadline arrives.
 * Requests are never dispatched after their deadline; a late request is
 * rejected with `RequestTimeoutError` instead.
 */
export class BatchScheduler<T = unknown, R = unknown> {
  #maxBatchSize: number;
  #maxWaitMs: number;
  #clock: Clock;
  #handler: BatchHandler<T, R> | undefined;
  #buckets = new Map<string, PendingBucket<T, R>>();
  #pendingById = new Map<string, PendingRequest<T, R>>();
  #inFlight = new Set<Promise<void>>();
  #timer: unknown;
  #hasTimer = false;
  #nextBatchId = 1;
  #dispatchedBatches = 0;
  #timedOutRequests = 0;
  #cancelledRequests = 0;
  #closed = false;
  #activeVersion: ModelVersion | undefined;
  #retiredVersions = new Set<string>();
  #rejectRetiredVersions = false;

  constructor(options: BatchSchedulerOptions<T, R> = {}) {
    this.#maxBatchSize = positiveInteger(
      options.maxBatchSize ?? options.maxBatch ?? options.batchSize,
      DEFAULT_MAX_BATCH_SIZE,
      "maxBatchSize",
    );
    this.#maxWaitMs = nonNegativeNumber(
      options.maxWaitMs ??
        options.maxWait ??
        options.maxQueueWaitMs ??
        options.batchWindowMs,
      DEFAULT_MAX_WAIT_MS,
      "maxWaitMs",
    );
    this.#clock = options.clock ?? systemClock;
    this.#handler = options.handler ?? options.onBatch ?? options.executeBatch;
    this.#activeVersion = options.defaultModelVersion ?? options.modelVersion;
  }

  get activeVersion(): ModelVersion | undefined {
    return this.#activeVersion;
  }

  get pendingRequestCount(): number {
    return this.#pendingById.size;
  }

  get pendingBatchCount(): number {
    return this.#buckets.size;
  }

  get inFlightBatchCount(): number {
    return this.#inFlight.size;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get stats(): BatchSchedulerStats {
    return {
      pendingRequests: this.#pendingById.size,
      pendingBatches: this.#buckets.size,
      inFlightBatches: this.#inFlight.size,
      dispatchedBatches: this.#dispatchedBatches,
      timedOutRequests: this.#timedOutRequests,
      cancelledRequests: this.#cancelledRequests,
      activeVersion: this.#activeVersion,
    };
  }

  submit(request: BatchRequest<T>): Promise<R> {
    if (this.#closed) {
      return Promise.reject(new SchedulerClosedError());
    }

    const now = this.#clock.now();
    const version = request.modelVersion ?? this.#activeVersion;
    if (version === undefined) {
      throw new TypeError(
        "request.modelVersion is required when the scheduler has no active version",
      );
    }
    if (typeof request.id !== "string" || request.id.length === 0) {
      throw new TypeError("request.id must be a non-empty string");
    }
    if (!Number.isFinite(request.deadline)) {
      throw new RangeError("request.deadline must be an absolute finite time");
    }
    if (this.#pendingById.has(request.id)) {
      return Promise.reject(new DuplicateRequestError(request.id));
    }
    if (request.signal?.aborted) {
      return Promise.reject(new RequestCancelledError(request.id));
    }
    if (this.#rejectRetiredVersions && this.#retiredVersions.has(versionKey(version))) {
      return Promise.reject(new StaleModelVersionError(version));
    }
    if (request.deadline < now) {
      this.#timedOutRequests++;
      return Promise.reject(new RequestTimeoutError(request.id, request.deadline, now));
    }

    const shape = copyShape(request.inputShape);
    const key = JSON.stringify([versionKey(version), shapeKey(shape)]);
    const view: ScheduledRequest<T> = Object.freeze({
      id: request.id,
      modelVersion: version,
      inputShape: shape,
      deadline: request.deadline,
      payload: request.payload,
      signal: request.signal,
      enqueuedAt: now,
    });

    let resolveRequest!: (value: R) => void;
    let rejectRequest!: (reason: unknown) => void;
    const promise = new Promise<R>((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });

    const pending: PendingRequest<T, R> = {
      view,
      key,
      resolve: resolveRequest,
      reject: rejectRequest,
      abortListener: undefined,
      state: "pending",
    };

    if (request.signal !== undefined) {
      const abortListener = () => {
        this.cancel(request.id, new RequestCancelledError(request.id));
      };
      pending.abortListener = abortListener;
      request.signal.addEventListener("abort", abortListener, { once: true });
    }

    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        key,
        modelVersion: version,
        inputShape: shape,
        requests: [],
        openedAt: now,
      };
      this.#buckets.set(key, bucket);
    }
    bucket.requests.push(pending);
    this.#pendingById.set(request.id, pending);

    this.#pump(now);
    return promise;
  }

  enqueue(request: BatchRequest<T>): Promise<R> {
    return this.submit(request);
  }

  /**
   * Cancel only a request that has not been dispatched. Returns false for
   * unknown or already-dispatched ids, whose execution is left untouched.
   */
  cancel(requestId: string, reason?: unknown): boolean {
    const pending = this.#pendingById.get(requestId);
    if (pending === undefined || pending.state !== "pending") {
      return false;
    }

    const bucket = this.#buckets.get(pending.key);
    if (bucket !== undefined) {
      const index = bucket.requests.indexOf(pending);
      if (index >= 0) {
        bucket.requests.splice(index, 1);
      }
      this.#refreshBucket(bucket);
    }

    this.#pendingById.delete(requestId);
    pending.state = "cancelled";
    this.#cancelledRequests++;
    this.#detachAbort(pending);
    pending.reject(
      reason instanceof RequestCancelledError
        ? reason
        : new RequestCancelledError(requestId, reason),
    );
    this.#pump(this.#clock.now());
    return true;
  }

  /** Dispatch every currently pending request immediately. */
  flush(version?: ModelVersion, inputShape?: InputShape): void {
    const now = this.#clock.now();
    this.#flushBuckets(now, "flush", version, inputShape);
  }

  /**
   * Switch versions. Existing cohorts are sealed and dispatched under the old
   * version by default; in-flight batches are never cancelled or mutated.
   * Later submissions without an explicit version use the new version.
   */
  switchVersion(version: ModelVersion, options: SwitchVersionOptions = {}): void {
    const previous = this.#activeVersion;
    this.#activeVersion = version;
    if (previous !== undefined && !sameVersion(previous, version)) {
      this.#retiredVersions.add(versionKey(previous));
    }
    this.#rejectRetiredVersions = options.rejectRetiredVersions === true;

    if (options.flushPending !== false) {
      this.#flushBuckets(this.#clock.now(), "version-switch");
    } else {
      this.#schedule(this.#clock.now());
    }
  }

  setModelVersion(version: ModelVersion, options?: SwitchVersionOptions): void {
    this.switchVersion(version, options);
  }

  setActiveVersion(version: ModelVersion, options?: SwitchVersionOptions): void {
    this.switchVersion(version, options);
  }

  /** Flush pending work and wait for every dispatched handler to settle. */
  async drain(): Promise<void> {
    while (true) {
      if (!this.#closed) {
        this.flush();
      }
      if (this.#inFlight.size > 0) {
        await Promise.all([...this.#inFlight]);
        continue;
      }
      if (this.#closed || this.#pendingById.size === 0) {
        return;
      }
    }
  }

  /** Stop accepting requests and reject all still-pending ones. */
  close(reason: unknown = new SchedulerClosedError()): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#clearTimer();
    for (const pending of [...this.#pendingById.values()]) {
      const bucket = this.#buckets.get(pending.key);
      if (bucket !== undefined) {
        const index = bucket.requests.indexOf(pending);
        if (index >= 0) {
          bucket.requests.splice(index, 1);
        }
        this.#refreshBucket(bucket);
      }
      pending.state = "cancelled";
      this.#pendingById.delete(pending.view.id);
      this.#detachAbort(pending);
      pending.reject(reason);
    }
    this.#buckets.clear();
  }

  #pump(now: number): void {
    if (this.#closed) {
      return;
    }
    this.#expireLateRequests(now);

    let changed = true;
    while (changed) {
      changed = false;
      for (const bucket of [...this.#buckets.values()]) {
        if (bucket.requests.length === 0) {
          this.#buckets.delete(bucket.key);
          continue;
        }
        if (this.#dispatchTrigger(bucket, now) !== undefined) {
          changed = true;
        }
      }
    }
    this.#schedule(now);
  }

  #flushBuckets(
    now: number,
    trigger: BatchTrigger,
    version?: ModelVersion,
    inputShape?: InputShape,
  ): void {
    this.#expireLateRequests(now);
    const filterShape = inputShape === undefined ? undefined : shapeKey(inputShape);
    for (const bucket of [...this.#buckets.values()]) {
      if (version !== undefined && !sameVersion(bucket.modelVersion, version)) {
        continue;
      }
      if (filterShape !== undefined && shapeKey(bucket.inputShape) !== filterShape) {
        continue;
      }
      this.#dispatchBucket(bucket, now, trigger);
    }
    this.#schedule(now);
  }

  #dispatchTrigger(
    bucket: PendingBucket<T, R>,
    now: number,
  ): BatchTrigger | undefined {
    if (bucket.requests.length >= this.#maxBatchSize) {
      this.#dispatchBucket(bucket, now, "batch-full");
      return "batch-full";
    }

    let earliestDeadline = Number.POSITIVE_INFINITY;
    for (const request of bucket.requests) {
      earliestDeadline = Math.min(earliestDeadline, request.view.deadline);
    }
    if (earliestDeadline <= now) {
      this.#dispatchBucket(bucket, now, "deadline");
      return "deadline";
    }
    if (bucket.openedAt + this.#maxWaitMs <= now) {
      this.#dispatchBucket(bucket, now, "wait-expired");
      return "wait-expired";
    }
    return undefined;
  }

  #dispatchBucket(
    bucket: PendingBucket<T, R>,
    now: number,
    trigger: BatchTrigger,
  ): void {
    if (bucket.requests.length === 0) {
      this.#buckets.delete(bucket.key);
      return;
    }

    if (this.#buckets.get(bucket.key) === bucket) {
      this.#buckets.delete(bucket.key);
    }

    for (let start = 0; start < bucket.requests.length; start += this.#maxBatchSize) {
      const requests = bucket.requests.slice(start, start + this.#maxBatchSize);
      this.#dispatchBatch(bucket, requests, now, trigger);
    }
  }

  #dispatchBatch(
    bucket: PendingBucket<T, R>,
    requests: PendingRequest<T, R>[],
    now: number,
    trigger: BatchTrigger,
  ): void {
    const views = requests.map((request) => request.view);
    const deadline = Math.min(...views.map((request) => request.deadline));
    const batch: Batch<T> = Object.freeze({
      id: `batch-${this.#nextBatchId++}`,
      key: bucket.key,
      modelVersion: bucket.modelVersion,
      inputShape: bucket.inputShape,
      requests: Object.freeze(views),
      size: views.length,
      openedAt: bucket.openedAt,
      dispatchedAt: now,
      deadline,
      trigger,
    });

    for (const pending of requests) {
      pending.state = "dispatched";
      this.#pendingById.delete(pending.view.id);
      this.#detachAbort(pending);
    }
    this.#dispatchedBatches++;

    const execution = this.#execute(batch, requests);
    this.#inFlight.add(execution);
    void execution.then(
      () => {
        this.#inFlight.delete(execution);
      },
      () => {
        this.#inFlight.delete(execution);
      },
    );
  }

  #execute(batch: Batch<T>, requests: PendingRequest<T, R>[]): Promise<void> {
    let output:
      | R
      | readonly R[]
      | ReadonlyMap<string, R>
      | Promise<R | readonly R[] | ReadonlyMap<string, R>>
      | undefined;

    try {
      output = this.#handler?.(batch);
    } catch (error) {
      this.#rejectBatch(requests, error);
      return Promise.resolve();
    }

    return Promise.resolve(output).then(
      (value) => {
        requests.forEach((request, index) => {
          request.resolve(resultForRequest(value, request.view, index, requests.length));
        });
      },
      (error: unknown) => {
        this.#rejectBatch(requests, error);
      },
    );
  }

  #rejectBatch(requests: PendingRequest<T, R>[], error: unknown): void {
    for (const request of requests) {
      request.reject(error);
    }
  }

  #expireLateRequests(now: number): void {
    for (const pending of [...this.#pendingById.values()]) {
      if (pending.view.deadline >= now) {
        continue;
      }
      const bucket = this.#buckets.get(pending.key);
      if (bucket !== undefined) {
        const index = bucket.requests.indexOf(pending);
        if (index >= 0) {
          bucket.requests.splice(index, 1);
        }
        this.#refreshBucket(bucket);
      }

      pending.state = "timed-out";
      this.#pendingById.delete(pending.view.id);
      this.#timedOutRequests++;
      this.#detachAbort(pending);
      pending.reject(
        new RequestTimeoutError(
          pending.view.id,
          pending.view.deadline,
          now,
        ),
      );
    }
  }

  #refreshBucket(bucket: PendingBucket<T, R>): void {
    if (bucket.requests.length === 0) {
      if (this.#buckets.get(bucket.key) === bucket) {
        this.#buckets.delete(bucket.key);
      }
      return;
    }
    bucket.openedAt = Math.min(
      ...bucket.requests.map((request) => request.view.enqueuedAt),
    );
  }

  #detachAbort(pending: PendingRequest<T, R>): void {
    if (pending.abortListener !== undefined && pending.view.signal !== undefined) {
      pending.view.signal.removeEventListener("abort", pending.abortListener);
      pending.abortListener = undefined;
    }
  }

  #schedule(now: number): void {
    this.#clearTimer();
    if (this.#closed) {
      return;
    }

    let dueAt = Number.POSITIVE_INFINITY;
    for (const bucket of this.#buckets.values()) {
      if (bucket.requests.length === 0) {
        continue;
      }
      let earliestDeadline = Number.POSITIVE_INFINITY;
      for (const request of bucket.requests) {
        earliestDeadline = Math.min(earliestDeadline, request.view.deadline);
      }
      dueAt = Math.min(
        dueAt,
        bucket.openedAt + this.#maxWaitMs,
        earliestDeadline,
      );
    }

    if (!Number.isFinite(dueAt)) {
      return;
    }

    const delay = Math.max(0, dueAt - now);
    this.#timer = this.#clock.setTimeout(() => {
      this.#hasTimer = false;
      this.#timer = undefined;
      this.#pump(this.#clock.now());
    }, delay);
    this.#hasTimer = true;
  }

  #clearTimer(): void {
    if (this.#hasTimer) {
      this.#clock.clearTimeout(this.#timer);
      this.#timer = undefined;
      this.#hasTimer = false;
    }
  }
}

export { BatchScheduler as BatchCoordinator };
export { BatchScheduler as Batcher };
export { BatchScheduler as ModelBatchScheduler };

export function createBatchScheduler<T = unknown, R = unknown>(
  options: BatchSchedulerOptions<T, R>,
): BatchScheduler<T, R> {
  return new BatchScheduler<T, R>(options);
}

export { createBatchScheduler as createBatcher };
