export type BatchResultStatus =
  | "success"
  | "succeeded"
  | "successful"
  | "ok"
  | "accepted"
  | "retryable"
  | "retry"
  | "retryable_error"
  | "retryable_failure"
  | "transient"
  | "error"
  | "failed"
  | "failure"
  | "permanent"
  | "permanent_error"
  | "permanent_failure"
  | "non_retryable"
  | "non-retryable"
  | "fatal"
  | "rejected"
  | "missing"
  | "absent"
  | "not_found";

export interface SubRequest<T = unknown> {
  readonly clientItemId: string;
  readonly idempotencyKey: string;
  readonly payload?: T;
  readonly [key: string]: unknown;
}

export interface BatchResultPayload<T = unknown> {
  readonly clientItemId?: string;
  readonly status?: BatchResultStatus;
  readonly outcome?: BatchResultStatus;
  readonly ok?: boolean;
  readonly retryable?: boolean;
  readonly missing?: boolean;
  readonly value?: T;
  readonly result?: T;
  readonly data?: T;
  readonly error?: unknown;
  readonly idempotencyKey?: string;
  readonly [key: string]: unknown;
}

export interface BatchResultItem<T = unknown> extends BatchResultPayload<T> {
  readonly clientItemId: string;
}

export type BatchResultCollection<T = unknown> =
  | readonly BatchResultItem<T>[]
  | Readonly<Record<string, BatchResultPayload<T>>>
  | ReadonlyMap<string, BatchResultPayload<T>>;

export interface BatchResponseEnvelope<T = unknown> {
  readonly results?: BatchResultCollection<T>;
  readonly items?: BatchResultCollection<T>;
  readonly subRequestResults?: BatchResultCollection<T>;
  readonly timedOut?: boolean;
  readonly timeout?: boolean;
  readonly status?: string;
  readonly error?: unknown;
}

export type BatchResponse<T = unknown> =
  | BatchResultCollection<T>
  | BatchResponseEnvelope<T>;

export type SubRequestState =
  | "pending"
  | "success"
  | "retryable"
  | "failed"
  | "missing"
  | "quarantined";

export type SubRequestOutcome =
  | "pending"
  | "success"
  | "retryable"
  | "permanent_failure"
  | "missing"
  | "quarantined";

export type SubRequestReason =
  | "response"
  | "missing-in-response"
  | "missing-after-batch"
  | "batch-timeout"
  | "conflicting-duplicates"
  | "idempotency-key-mismatch";

export type RetryReason = "retryable" | "missing" | "timeout" | "pending";

export type QuarantineReason =
  | "conflicting-duplicates"
  | "idempotency-key-mismatch";

export interface ResultObservation<T = unknown> {
  readonly status: "success" | "retryable" | "failed";
  readonly value?: T;
  readonly error?: unknown;
  readonly idempotencyKey: string;
}

export interface QuarantineInfo<T = unknown> {
  readonly clientItemId: string;
  readonly reason: QuarantineReason;
  readonly message: string;
  readonly observations: readonly ResultObservation<T>[];
}

export interface SubRequestRecord<T = unknown> {
  readonly clientItemId: string;
  readonly idempotencyKey: string;
  readonly request: SubRequest<T>;
  readonly state: SubRequestState;
  readonly status: SubRequestState;
  readonly outcome: SubRequestOutcome;
  readonly ok: boolean;
  readonly retryable: boolean;
  readonly permanentFailure: boolean;
  readonly missing: boolean;
  readonly quarantined: boolean;
  readonly value?: T;
  readonly result?: T;
  readonly error?: unknown;
  readonly reason?: SubRequestReason;
  readonly duplicateCount: number;
  readonly resultCount: number;
  readonly observations: readonly ResultObservation<T>[];
  readonly quarantine?: QuarantineInfo<T>;
}

export interface ApplyBatchOptions {
  readonly finalizeMissing?: boolean;
  readonly timedOut?: boolean;
  readonly batchTimedOut?: boolean;
  readonly timeout?: boolean;
  readonly batchTimeout?: boolean;
}

export interface RetryBatchOptions {
  readonly includeMissing?: boolean;
  readonly includeUnresolved?: boolean;
  readonly includePending?: boolean;
}

export interface SubRequestBatchStateOptions {
  readonly finalizeMissing?: boolean;
}

export type RetryBatch<T = unknown> = SubRequest<T>[] & {
  readonly items: SubRequest<T>[];
  readonly requests: SubRequest<T>[];
  readonly subRequests: SubRequest<T>[];
  readonly clientItemIds: string[];
  readonly reasons: Record<string, RetryReason>;
};

export interface SubRequestSnapshot<T = unknown> {
  readonly items: readonly SubRequestRecord<T>[];
  readonly byClientItemId: ReadonlyMap<string, SubRequestRecord<T>>;
  readonly success: readonly SubRequestRecord<T>[];
  readonly succeeded: readonly SubRequestRecord<T>[];
  readonly retryable: readonly SubRequestRecord<T>[];
  readonly failed: readonly SubRequestRecord<T>[];
  readonly permanentFailures: readonly SubRequestRecord<T>[];
  readonly missing: readonly SubRequestRecord<T>[];
  readonly quarantined: readonly SubRequestRecord<T>[];
  readonly pending: readonly SubRequestRecord<T>[];
  readonly retryBatch: RetryBatch<T>;
  readonly retryRequests: RetryBatch<T>;
  readonly toRetry: RetryBatch<T>;
  readonly retry: RetryBatch<T>;
  readonly retryItems: RetryBatch<T>;
  readonly unknownResults: readonly BatchResultItem<T>[];
  readonly unmatchedResults: readonly BatchResultItem<T>[];
  readonly orphanedResults: readonly BatchResultItem<T>[];
  readonly retryableRequests: readonly SubRequest<T>[];
  readonly missingRequests: readonly SubRequest<T>[];
  readonly counts: Readonly<{
    total: number;
    pending: number;
    success: number;
    succeeded: number;
    retryable: number;
    failed: number;
    missing: number;
    quarantined: number;
  }>;
}

export interface BatchReconciliation<T = unknown> extends SubRequestSnapshot<T> {
  readonly tracker: SubRequestBatchState<T>;
  readonly state: SubRequestBatchState<T>;
}

export class DuplicateClientItemIdError extends Error {
  readonly clientItemId: string;

  constructor(clientItemId: string) {
    super(`Duplicate clientItemId: ${JSON.stringify(clientItemId)}`);
    this.name = "DuplicateClientItemIdError";
    this.clientItemId = clientItemId;
  }
}

export class InvalidBatchResultError extends Error {
  readonly clientItemId: unknown;

  constructor(message: string, clientItemId?: unknown) {
    super(message);
    this.name = "InvalidBatchResultError";
    this.clientItemId = clientItemId;
  }
}

interface Observation<T> {
  readonly status: "success" | "retryable" | "failed";
  readonly hasValue: boolean;
  readonly value?: T;
  readonly hasError: boolean;
  readonly error?: unknown;
  readonly idempotencyKey: string;
}

interface MutableRecord<T> {
  readonly request: SubRequest<T>;
  state: SubRequestState;
  outcome: SubRequestOutcome;
  value?: T;
  error?: unknown;
  reason?: SubRequestReason;
  duplicateCount: number;
  observations: Observation<T>[];
  quarantine?: {
    readonly reason: QuarantineReason;
    readonly message: string;
  };
}

const SUCCESS_STATUSES = new Set([
  "success",
  "succeeded",
  "successful",
  "ok",
  "accepted",
]);
const RETRYABLE_STATUSES = new Set([
  "retryable",
  "retry",
  "retryable_error",
  "retryable_failure",
  "transient",
]);
const PERMANENT_STATUSES = new Set([
  "failed",
  "failure",
  "permanent",
  "permanent_error",
  "permanent_failure",
  "non_retryable",
  "non-retryable",
  "fatal",
  "rejected",
]);
const MISSING_STATUSES = new Set(["missing", "absent", "not_found"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function outcomeForState(state: SubRequestState): SubRequestOutcome {
  return state === "failed" ? "permanent_failure" : state;
}

function observationEquals<T>(left: Observation<T>, right: Observation<T>): boolean {
  return deepEqual(
    {
      status: left.status,
      hasValue: left.hasValue,
      value: left.value,
      hasError: left.hasError,
      error: left.error,
      idempotencyKey: left.idempotencyKey,
    },
    {
      status: right.status,
      hasValue: right.hasValue,
      value: right.value,
      hasError: right.hasError,
      error: right.error,
      idempotencyKey: right.idempotencyKey,
    },
  );
}

function deepEqual(
  left: unknown,
  right: unknown,
  seen: WeakMap<object, WeakSet<object>> = new WeakMap(),
): boolean {
  if (left === right) return true;
  if (
    typeof left === "number" &&
    typeof right === "number" &&
    Number.isNaN(left) &&
    Number.isNaN(right)
  ) {
    return true;
  }
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null
  ) {
    return false;
  }

  let rightSet = seen.get(left);
  if (rightSet?.has(right)) return true;
  if (!rightSet) {
    rightSet = new WeakSet();
    seen.set(left, rightSet);
  }
  rightSet.add(right);

  if (left instanceof Date || right instanceof Date) {
    return (
      left instanceof Date &&
      right instanceof Date &&
      left.getTime() === right.getTime()
    );
  }
  if (left instanceof RegExp || right instanceof RegExp) {
    return (
      left instanceof RegExp &&
      right instanceof RegExp &&
      left.source === right.source &&
      left.flags === right.flags
    );
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!deepEqual(left[index], right[index], seen)) return false;
    }
    return true;
  }
  if (left instanceof Map || right instanceof Map) {
    if (!(left instanceof Map) || !(right instanceof Map)) return false;
    if (left.size !== right.size) return false;
    for (const [leftKey, leftValue] of left) {
      let matched = false;
      for (const [rightKey, rightValue] of right) {
        if (
          deepEqual(leftKey, rightKey, seen) &&
          deepEqual(leftValue, rightValue, seen)
        ) {
          matched = true;
          break;
        }
      }
      if (!matched) return false;
    }
    return true;
  }
  if (left instanceof Set || right instanceof Set) {
    if (!(left instanceof Set) || !(right instanceof Set)) return false;
    if (left.size !== right.size) return false;
    for (const leftValue of left) {
      let matched = false;
      for (const rightValue of right) {
        if (deepEqual(leftValue, rightValue, seen)) {
          matched = true;
          break;
        }
      }
      if (!matched) return false;
    }
    return true;
  }
  if (ArrayBuffer.isView(left) || ArrayBuffer.isView(right)) {
    if (!ArrayBuffer.isView(left) || !ArrayBuffer.isView(right)) return false;
    const leftBytes = new Uint8Array(
      left.buffer,
      left.byteOffset,
      left.byteLength,
    );
    const rightBytes = new Uint8Array(
      right.buffer,
      right.byteOffset,
      right.byteLength,
    );
    if (leftBytes.length !== rightBytes.length) return false;
    for (let index = 0; index < leftBytes.length; index += 1) {
      if (leftBytes[index] !== rightBytes[index]) return false;
    }
    return true;
  }
  if (left instanceof Error || right instanceof Error) {
    if (!(left instanceof Error) || !(right instanceof Error)) return false;
    if (left.name !== right.name || left.message !== right.message) return false;
  }

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
    if (
      !deepEqual(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
        seen,
      )
    ) {
      return false;
    }
  }
  return true;
}

function normalizeStatus(item: BatchResultItem<unknown>): Observation<unknown>["status"] | "missing" {
  const rawStatus = item.status ?? item.outcome;
  if (typeof rawStatus === "string") {
    const status = rawStatus.toLowerCase();
    if (SUCCESS_STATUSES.has(status)) return "success";
    if (RETRYABLE_STATUSES.has(status)) return "retryable";
    if (status === "error") {
      const error = isRecord(item.error) ? item.error : undefined;
      return item.retryable === true ||
        error?.retryable === true ||
        error?.transient === true
        ? "retryable"
        : "failed";
    }
    if (PERMANENT_STATUSES.has(status)) return "failed";
    if (MISSING_STATUSES.has(status)) return "missing";
    throw new InvalidBatchResultError(
      `Unknown batch result status: ${JSON.stringify(rawStatus)}`,
      item.clientItemId,
    );
  }

  if (item.missing === true) return "missing";
  if (item.ok === true) return "success";
  if (item.retryable === true) return "retryable";

  const error = isRecord(item.error) ? item.error : undefined;
  if (item.ok === false) {
    return error?.retryable === true || error?.transient === true
      ? "retryable"
      : "failed";
  }
  if (error?.retryable === true) return "retryable";
  if (error?.transient === true) return "retryable";
  if (error?.retryable === false) return "failed";
  if (error?.permanent === true) return "failed";
  if ("error" in item && item.error !== undefined) return "failed";
  if ("value" in item || "result" in item || "data" in item) return "success";
  throw new InvalidBatchResultError(
    "Batch result needs a status, ok flag, retryable flag, or missing flag",
    item.clientItemId,
  );
}

function normalizeObservation<T>(
  item: BatchResultItem<T>,
  request: SubRequest<T>,
): Observation<T> {
  const kind = normalizeStatus(item as BatchResultItem<unknown>);
  if (kind === "missing") {
    throw new InvalidBatchResultError(
      "A missing result cannot be recorded as an observation",
      item.clientItemId,
    );
  }

  const hasValue =
    kind === "success" &&
    ("value" in item || "result" in item || "data" in item);
  const value = hasValue
    ? "value" in item
      ? item.value
      : "result" in item
        ? item.result
        : item.data
    : undefined;
  const hasError = "error" in item && item.error !== undefined;

  if (
    item.idempotencyKey !== undefined &&
    typeof item.idempotencyKey !== "string"
  ) {
    throw new InvalidBatchResultError(
      "idempotencyKey must be a string when provided",
      item.clientItemId,
    );
  }
  const idempotencyKey = item.idempotencyKey ?? request.idempotencyKey;

  return {
    status: kind,
    hasValue,
    value,
    hasError,
    error: item.error,
    idempotencyKey,
  };
}

function observationSummary<T>(
  observation: Observation<T>,
): ResultObservation<T> {
  return {
    status: observation.status,
    value: observation.value,
    error: observation.error,
    idempotencyKey: observation.idempotencyKey,
  };
}

function publicRecord<T>(record: MutableRecord<T>): SubRequestRecord<T> {
  const quarantine: QuarantineInfo<T> | undefined =
    record.quarantine === undefined
      ? undefined
      : {
          clientItemId: record.request.clientItemId,
          reason: record.quarantine.reason,
          message: record.quarantine.message,
          observations: record.observations.map(observationSummary),
        };
  return {
    clientItemId: record.request.clientItemId,
    idempotencyKey: record.request.idempotencyKey,
    request: record.request,
    state: record.state,
    status: record.state,
    outcome: record.outcome,
    ok: record.state === "success",
    retryable: record.state === "retryable",
    permanentFailure: record.state === "failed",
    missing: record.state === "missing",
    quarantined: record.state === "quarantined",
    value: record.value,
    result: record.value,
    error: record.error,
    reason: record.reason,
    duplicateCount: record.duplicateCount,
    resultCount: record.observations.length,
    observations: record.observations.map(observationSummary),
    quarantine,
  };
}

function attachRetryMetadata<T>(
  items: SubRequest<T>[],
  reasons: Record<string, RetryReason>,
): RetryBatch<T> {
  const batch = items as RetryBatch<T>;
  Object.defineProperties(batch, {
    items: { value: batch, enumerable: false },
    requests: { value: batch, enumerable: false },
    subRequests: { value: batch, enumerable: false },
    clientItemIds: {
      value: items.map((item) => item.clientItemId),
      enumerable: false,
    },
    reasons: { value: reasons, enumerable: false },
  });
  return batch;
}

function readCollection<T>(
  collection: BatchResultCollection<T>,
): readonly BatchResultItem<T>[] {
  if (Array.isArray(collection)) return collection;
  if (collection instanceof Map) {
    return Array.from(collection, ([clientItemId, item]) => {
      if (!isRecord(item)) {
        throw new InvalidBatchResultError("Batch result must be an object");
      }
      return {
        ...(item as BatchResultItem<T>),
        clientItemId:
          typeof item.clientItemId === "string"
            ? item.clientItemId
            : clientItemId,
      };
    });
  }
  if (collection === null || typeof collection !== "object") {
    throw new TypeError("Batch result collection must be an array or map");
  }
  return Object.entries(collection).map(([clientItemId, item]) => {
    if (!isRecord(item)) {
      throw new InvalidBatchResultError("Batch result must be an object");
    }
    return {
      ...(item as BatchResultItem<T>),
      clientItemId:
        typeof item.clientItemId === "string" ? item.clientItemId : clientItemId,
    };
  });
}

function readBatchResponse<T>(response: BatchResponse<T>, timedOutOption?: boolean): {
  entries: readonly BatchResultItem<T>[];
  timedOut: boolean;
} {
  if (
    Array.isArray(response) ||
    response instanceof Map
  ) {
    return {
      entries: readCollection(response as BatchResultCollection<T>),
      timedOut: timedOutOption === true,
    };
  }
  if (response === null || typeof response !== "object") {
    throw new TypeError("Batch response must be an array or an object");
  }
  const envelope = response as BatchResponseEnvelope<T>;
  let entries: readonly BatchResultItem<T>[] = [];
  if (envelope.results !== undefined) {
    entries = readCollection(envelope.results);
  } else if (envelope.items !== undefined) {
    entries = readCollection(envelope.items);
  } else if (envelope.subRequestResults !== undefined) {
    entries = readCollection(envelope.subRequestResults);
  } else if (
    typeof (envelope as unknown as BatchResultItem<T>).clientItemId === "string"
  ) {
    entries = [envelope as unknown as BatchResultItem<T>];
  }
  return {
    entries,
    timedOut:
      timedOutOption === true ||
      envelope.timedOut === true ||
      envelope.timeout === true ||
      envelope.status?.toLowerCase() === "timeout" ||
      envelope.status?.toLowerCase() === "timed_out",
  };
}

export class SubRequestBatchState<T = unknown> {
  readonly #records = new Map<string, MutableRecord<T>>();
  readonly #finalizeMissingDefault: boolean;
  #unknownResults: BatchResultItem<T>[] = [];
  #timedOut = false;
  #completed = false;

  constructor(
    requests: readonly SubRequest<T>[],
    options: SubRequestBatchStateOptions = {},
  ) {
    this.#finalizeMissingDefault = options.finalizeMissing !== false;
    for (const request of requests) {
      if (
        typeof request?.clientItemId !== "string" ||
        request.clientItemId.length === 0
      ) {
        throw new TypeError("Every sub-request needs a non-empty clientItemId");
      }
      if (
        typeof request.idempotencyKey !== "string" ||
        request.idempotencyKey.length === 0
      ) {
        throw new TypeError("Every sub-request needs a non-empty idempotencyKey");
      }
      if (this.#records.has(request.clientItemId)) {
        throw new DuplicateClientItemIdError(request.clientItemId);
      }
      this.#records.set(request.clientItemId, {
        request,
        state: "pending",
        outcome: "pending",
        duplicateCount: 0,
        observations: [],
      });
    }
  }

  get size(): number {
    return this.#records.size;
  }

  get timedOut(): boolean {
    return this.#timedOut;
  }

  get completed(): boolean {
    return this.#completed;
  }

  has(clientItemId: string): boolean {
    return this.#records.has(clientItemId);
  }

  getRecord(clientItemId: string): SubRequestRecord<T> | undefined {
    const record = this.#records.get(clientItemId);
    return record === undefined ? undefined : publicRecord(record);
  }

  getState(clientItemId: string): SubRequestState | undefined {
    return this.#records.get(clientItemId)?.state;
  }

  applyResponse(
    response: BatchResponse<T>,
    options: ApplyBatchOptions = {},
  ): this {
    const { entries, timedOut } = readBatchResponse(
      response,
      options.timedOut === true ||
        options.batchTimedOut === true ||
        options.timeout === true ||
        options.batchTimeout === true,
    );

    const unknownResults: BatchResultItem<T>[] = [];
    const observations: Array<{
      record: MutableRecord<T>;
      observation: Observation<T>;
      providedIdempotencyKey?: string;
    }> = [];
    const missing: Array<{
      record: MutableRecord<T>;
      providedIdempotencyKey?: string;
    }> = [];

    for (const entry of entries) {
      if (!isRecord(entry)) {
        throw new InvalidBatchResultError("Batch result must be an object");
      }
      const clientItemId = entry.clientItemId;
      if (typeof clientItemId !== "string" || clientItemId.length === 0) {
        throw new InvalidBatchResultError(
          "Batch result needs a non-empty clientItemId",
          clientItemId,
        );
      }
      const record = this.#records.get(clientItemId);
      if (record === undefined) {
        unknownResults.push(entry as BatchResultItem<T>);
        continue;
      }
      const kind = normalizeStatus(entry as BatchResultItem<unknown>);
      if (kind === "missing") {
        missing.push({
          record,
          providedIdempotencyKey:
            typeof entry.idempotencyKey === "string"
              ? entry.idempotencyKey
              : undefined,
        });
        continue;
      }
      const observation = normalizeObservation(
        entry as BatchResultItem<T>,
        record.request,
      );
      observations.push({
        record,
        observation,
        providedIdempotencyKey:
          typeof entry.idempotencyKey === "string"
            ? entry.idempotencyKey
            : undefined,
      });
    }

    for (const item of observations) {
      this.#applyObservation(
        item.record,
        item.observation,
        item.providedIdempotencyKey,
      );
    }
    for (const item of missing) {
      if (
        item.providedIdempotencyKey !== undefined &&
        item.providedIdempotencyKey !== item.record.request.idempotencyKey
      ) {
        this.#quarantine(
          item.record,
          "idempotency-key-mismatch",
          `Missing-result idempotencyKey ${JSON.stringify(item.providedIdempotencyKey)} does not match request key ${JSON.stringify(item.record.request.idempotencyKey)}`,
        );
      } else {
        this.#markMissing(item.record);
      }
    }
    for (const result of unknownResults) {
      this.#unknownResults.push(result);
    }

    if (timedOut) this.markTimedOut();
    const finalizeMissing =
      options.finalizeMissing ?? this.#finalizeMissingDefault;
    if (finalizeMissing) this.finalize();
    return this;
  }

  apply(response: BatchResponse<T>, options: ApplyBatchOptions = {}): this {
    return this.applyResponse(response, options);
  }

  recordResults(
    response: BatchResponse<T>,
    options: ApplyBatchOptions = {},
  ): this {
    return this.applyResponse(response, options);
  }

  handleResponse(
    response: BatchResponse<T>,
    options: ApplyBatchOptions = {},
  ): this {
    return this.applyResponse(response, options);
  }

  applyBatchResponse(
    response: BatchResponse<T>,
    options: ApplyBatchOptions = {},
  ): this {
    return this.applyResponse(response, options);
  }

  markTimedOut(): this {
    this.#timedOut = true;
    for (const record of this.#records.values()) {
      if (record.state === "pending" || record.state === "missing") {
        record.state = "retryable";
        record.outcome = "retryable";
        record.reason = "batch-timeout";
        record.value = undefined;
        record.error = undefined;
      }
    }
    return this;
  }

  timeout(): this {
    return this.markTimedOut();
  }

  markBatchTimedOut(): this {
    return this.markTimedOut();
  }

  finalize(): this {
    this.#completed = true;
    for (const record of this.#records.values()) {
      if (record.state === "pending") {
        record.state = "missing";
        record.outcome = "missing";
        record.reason = "missing-after-batch";
      }
    }
    return this;
  }

  complete(): this {
    return this.finalize();
  }

  finalizeMissing(): this {
    return this.finalize();
  }

  getRetryBatch(options: RetryBatchOptions = {}): RetryBatch<T> {
    const includeMissing =
      options.includeMissing === true ||
      (options.includeMissing === undefined &&
        options.includeUnresolved === true);
    const includePending = options.includePending === true;
    const items: SubRequest<T>[] = [];
    const reasons: Record<string, RetryReason> = {};

    for (const record of this.#records.values()) {
      let reason: RetryReason | undefined;
      if (record.state === "retryable") {
        reason = record.reason === "batch-timeout" ? "timeout" : "retryable";
      } else if (record.state === "missing" && includeMissing) {
        reason = "missing";
      } else if (record.state === "pending" && includePending) {
        reason = "pending";
      }
      if (reason === undefined) continue;
      const item = { ...record.request };
      items.push(item);
      reasons[record.request.clientItemId] = reason;
    }
    return attachRetryMetadata(items, reasons);
  }

  createRetryBatch(options: RetryBatchOptions = {}): RetryBatch<T> {
    return this.getRetryBatch(options);
  }

  buildRetryBatch(options: RetryBatchOptions = {}): RetryBatch<T> {
    return this.getRetryBatch(options);
  }

  get retryBatch(): RetryBatch<T> {
    return this.getRetryBatch();
  }

  get retryRequests(): RetryBatch<T> {
    return this.getRetryBatch();
  }

  get items(): readonly SubRequestRecord<T>[] {
    return this.snapshot().items;
  }

  snapshot(options: RetryBatchOptions = {}): SubRequestSnapshot<T> {
    const items = Array.from(this.#records.values(), publicRecord);
    const byClientItemId = new Map<string, SubRequestRecord<T>>();
    const success: SubRequestRecord<T>[] = [];
    const retryable: SubRequestRecord<T>[] = [];
    const failed: SubRequestRecord<T>[] = [];
    const missing: SubRequestRecord<T>[] = [];
    const quarantined: SubRequestRecord<T>[] = [];
    const pending: SubRequestRecord<T>[] = [];

    for (const item of items) {
      byClientItemId.set(item.clientItemId, item);
      if (item.state === "success") success.push(item);
      else if (item.state === "retryable") retryable.push(item);
      else if (item.state === "failed") failed.push(item);
      else if (item.state === "missing") missing.push(item);
      else if (item.state === "quarantined") quarantined.push(item);
      else pending.push(item);
    }

    const retryBatch = this.getRetryBatch(options);
    const cloneRequest = (record: SubRequestRecord<T>): SubRequest<T> => ({
      ...record.request,
    });
    const retryableRequests = retryable.map(cloneRequest);
    const missingRequests = missing.map(cloneRequest);
    return {
      items,
      byClientItemId,
      success,
      succeeded: success,
      retryable,
      failed,
      permanentFailures: failed,
      missing,
      quarantined,
      pending,
      retryBatch,
      retryRequests: retryBatch,
      toRetry: retryBatch,
      retry: retryBatch,
      retryItems: retryBatch,
      unknownResults: [...this.#unknownResults],
      unmatchedResults: [...this.#unknownResults],
      orphanedResults: [...this.#unknownResults],
      retryableRequests,
      missingRequests,
      counts: {
        total: items.length,
        pending: pending.length,
        success: success.length,
        succeeded: success.length,
        retryable: retryable.length,
        failed: failed.length,
        missing: missing.length,
        quarantined: quarantined.length,
      },
    };
  }

  #markMissing(record: MutableRecord<T>): void {
    if (
      record.state === "pending" ||
      record.state === "missing"
    ) {
      record.state = "missing";
      record.outcome = "missing";
      record.reason = "missing-in-response";
      record.value = undefined;
      record.error = undefined;
    }
  }

  #applyObservation(
    record: MutableRecord<T>,
    observation: Observation<T>,
    providedIdempotencyKey?: string,
  ): void {
    if (
      providedIdempotencyKey !== undefined &&
      providedIdempotencyKey !== record.request.idempotencyKey
    ) {
      record.observations.push(observation);
      this.#quarantine(
        record,
        "idempotency-key-mismatch",
        `Result idempotencyKey ${JSON.stringify(providedIdempotencyKey)} does not match request key ${JSON.stringify(record.request.idempotencyKey)}`,
      );
      return;
    }

    if (record.state === "quarantined") {
      record.observations.push(observation);
      return;
    }

    const first = record.observations[0];
    if (first !== undefined) {
      if (!observationEquals(first, observation)) {
        record.observations.push(observation);
        this.#quarantine(
          record,
          "conflicting-duplicates",
          `Conflicting results for clientItemId ${JSON.stringify(record.request.clientItemId)}`,
        );
        return;
      }
      record.duplicateCount += 1;
      return;
    }

    record.observations.push(observation);
    if (observation.status === "success") {
      record.state = "success";
      record.outcome = "success";
      record.value = observation.value;
      record.error = undefined;
    } else if (observation.status === "retryable") {
      record.state = "retryable";
      record.outcome = "retryable";
      record.value = undefined;
      record.error = observation.error;
    } else {
      record.state = "failed";
      record.outcome = "permanent_failure";
      record.value = undefined;
      record.error = observation.error;
    }
    record.reason = "response";
  }

  #quarantine(
    record: MutableRecord<T>,
    reason: QuarantineReason,
    message: string,
  ): void {
    record.state = "quarantined";
    record.outcome = "quarantined";
    record.reason = reason;
    record.value = undefined;
    record.error = undefined;
    record.quarantine = {
      reason,
      message,
    };
  }
}

export function createSubRequestBatchState<T = unknown>(
  requests: readonly SubRequest<T>[],
  options: SubRequestBatchStateOptions = {},
): SubRequestBatchState<T> {
  return new SubRequestBatchState(requests, options);
}

export function reconcileBatchResponse<T = unknown>(
  requests: readonly SubRequest<T>[],
  response: BatchResponse<T>,
  options: ApplyBatchOptions & RetryBatchOptions = {},
): BatchReconciliation<T> {
  const tracker = new SubRequestBatchState(requests, {
    finalizeMissing: options.finalizeMissing,
  });
  tracker.applyResponse(response, options);
  const snapshot = tracker.snapshot(options);
  return {
    ...snapshot,
    tracker,
    state: tracker,
  };
}

export function buildRetryBatch<T = unknown>(
  source: SubRequestBatchState<T> | readonly SubRequest<T>[],
  responseOrOptions?: BatchResponse<T> | RetryBatchOptions,
  options: ApplyBatchOptions & RetryBatchOptions = {},
): RetryBatch<T> {
  if (source instanceof SubRequestBatchState) {
    return source.getRetryBatch(
      (responseOrOptions as RetryBatchOptions | undefined) ?? {},
    );
  }
  const tracker = new SubRequestBatchState(source, {
    finalizeMissing: options.finalizeMissing,
  });
  tracker.applyResponse(
    (responseOrOptions as BatchResponse<T> | undefined) ?? [],
    options,
  );
  return tracker.getRetryBatch(options);
}

export { SubRequestBatchState as BatchSubRequestState };
export { SubRequestBatchState as SubRequestBatch };
export { SubRequestBatchState as BatchState };
export { SubRequestBatchState as SubRequestTracker };
export { SubRequestBatchState as BatchTracker };
export { SubRequestBatchState as SubRequestStateTracker };
export { SubRequestBatchState as SubRequestBatchTracker };
export { SubRequestBatchState as BatchSubRequestTracker };
export { createSubRequestBatchState as createBatchState };
export { createSubRequestBatchState as createSubRequestState };
export { createSubRequestBatchState as createBatchTracker };
export { createSubRequestBatchState as createSubRequestTracker };
export { reconcileBatchResponse as splitBatchResponse };
export { reconcileBatchResponse as splitBatchResults };
export { reconcileBatchResponse as splitBatch };
export { reconcileBatchResponse as reconcileSubRequests };
export { reconcileBatchResponse as reconcileBatch };
export { reconcileBatchResponse as reconcileBatchResults };
export { reconcileBatchResponse as resolveBatchResponse };
export { reconcileBatchResponse as applyBatchResponse };
export { reconcileBatchResponse as processBatchResponse };
export { buildRetryBatch as buildRetryRequests };
export { buildRetryBatch as createRetryBatch };
export { buildRetryBatch as getRetryBatch };
export type SubRequestStatus = SubRequestState;
export type BatchItemResult<T = unknown> = BatchResultItem<T>;
export type BatchResult<T = unknown> = BatchResultItem<T>;
export type BatchSubRequest<T = unknown> = SubRequest<T>;
