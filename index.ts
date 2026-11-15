/**
 * A small, dependency-free Pulsar cursor state machine.
 *
 * The component keeps two related positions:
 *
 * - the durable cursor (`cursor` / `committed`), which only moves over
 *   messages whose complete entry (including every batch child) is terminal;
 * - the first unresolved position, which is exposed through a pending
 *   interval together with the high-water mark that was observed.
 *
 * Message ids are ordered by `(ledgerId, entryId, batchIndex)`.  A non-batched
 * message uses `batchIndex === -1`, matching Pulsar's own convention.
 */

export type NumericId = bigint | number | string;

export interface MessageIdInput {
  ledgerId?: NumericId;
  entryId?: NumericId;
  /** Accepted aliases used by some Pulsar clients. */
  ledger?: NumericId;
  entry?: NumericId;
  ledgerID?: NumericId;
  entryID?: NumericId;
  LedgerId?: NumericId;
  EntryId?: NumericId;
  batchIndex?: number;
  batch?: number;
  batchSize?: number;
  size?: number;
  count?: number;
  partitionIndex?: number;
  partition?: number;
  /** Allow a nested `messageId` object. */
  messageId?: MessageIdInput;
}

export interface PulsarMessageId {
  ledgerId: bigint;
  entryId: bigint;
  batchIndex: number;
  partitionIndex?: number;
  batchSize?: number;
}

export type MessageId = PulsarMessageId;
export type Position = PulsarMessageId;
export type CursorPosition = PulsarMessageId;
export type TopicMessageId = PulsarMessageId;
export type IdLike = PulsarMessageId | MessageIdInput | readonly NumericId[];
export type MessageIdLike = MessageIdInput;
export type PulsarMessageIdLike = MessageIdInput;

export interface PendingInterval {
  /** First unresolved position, inclusive. */
  from: PulsarMessageId;
  /** Highest observed/known position, inclusive. */
  to: PulsarMessageId;
  readonly start?: PulsarMessageId;
  readonly end?: PulsarMessageId;
  readonly lower?: PulsarMessageId;
  readonly upper?: PulsarMessageId;
  readonly first?: PulsarMessageId;
  readonly last?: PulsarMessageId;
  readonly min?: PulsarMessageId;
  readonly max?: PulsarMessageId;
  readonly next?: PulsarMessageId;
  readonly high?: PulsarMessageId;
  readonly nextPosition?: PulsarMessageId;
  readonly lastPosition?: PulsarMessageId;
  readonly fromInclusive?: boolean;
  readonly toInclusive?: boolean;
  readonly fromExclusive?: boolean;
  readonly toExclusive?: boolean;
  readonly inclusive?: boolean;
  readonly positions?: PulsarMessageId[];
  readonly count?: number;
  readonly fromLedgerId?: bigint;
  readonly fromEntryId?: bigint;
  readonly fromBatchIndex?: number;
  readonly toLedgerId?: bigint;
  readonly toEntryId?: bigint;
  readonly toBatchIndex?: number;
  readonly startLedgerId?: bigint;
  readonly startEntryId?: bigint;
  readonly startBatchIndex?: number;
  readonly endLedgerId?: bigint;
  readonly endEntryId?: bigint;
  readonly endBatchIndex?: number;
  [key: string]: unknown;
}

export type BatchChildStatus = "pending" | "acked" | "denied" | "truncated";
export type PendingRange = PendingInterval;
export type AckResult = CursorUpdate;
export type CursorOptions = PulsarCursorOptions;

export interface CursorUpdate {
  accepted: boolean;
  changed: boolean;
  advanced: boolean;
  duplicate: boolean;
  stale: boolean;
  truncated: boolean;
  generation: number;
  cursor: PulsarMessageId | null;
  pending: PendingInterval | null;
  acknowledged: PulsarMessageId[];
  denied?: PulsarMessageId[];
  readonly position?: PulsarMessageId | null;
  readonly persistentCursor?: PulsarMessageId | null;
  readonly committed?: PulsarMessageId | null;
  readonly markDeletePosition?: PulsarMessageId | null;
  readonly pendingInterval?: PendingInterval | null;
  readonly pendingRange?: PendingInterval | null;
  readonly pendingWindow?: PendingInterval | null;
  readonly next?: PulsarMessageId | null;
  readonly last?: PulsarMessageId | null;
  readonly acked?: PulsarMessageId[];
  readonly acknowledgedIds?: PulsarMessageId[];
  readonly deniedIds?: PulsarMessageId[];
  [key: string]: unknown;
}

export interface Delivery {
  id: PulsarMessageId;
  token: string;
  generation: number;
  epoch: number;
  redelivered: boolean;
  terminal: boolean;
  readonly messageId?: PulsarMessageId;
  readonly position?: PulsarMessageId;
  readonly redelivery?: boolean;
  readonly attempt?: number;
  readonly deliveryEpoch?: number;
  readonly deliveryGeneration?: number;
  readonly ackToken?: string;
  readonly deliveryToken?: string;
  [key: string]: unknown;
}

export interface BatchState {
  id: PulsarMessageId;
  batchSize: number | null;
  sealed: boolean;
  acknowledged: number[];
  pending: number[];
  denied: number[];
  complete: boolean;
  readonly isComplete?: boolean;
  [key: string]: unknown;
}

export interface EntrySnapshot {
  id: PulsarMessageId;
  batchSize?: number;
  sealed: boolean;
  batch: boolean;
  children: Array<{
    batchIndex: number;
    status: BatchChildStatus;
    seen: boolean;
    attempts: number;
    epoch: number;
  }>;
}

export interface CursorSnapshot {
  version: 1;
  generation: number;
  cursor: PulsarMessageId | null;
  cumulativeAck: PulsarMessageId | null;
  truncation: PulsarMessageId | null;
  high: PulsarMessageId | null;
  entries: EntrySnapshot[];
}

export interface CursorState {
  generation: number;
  cursor: PulsarMessageId | null;
  cumulativeAck: PulsarMessageId | null;
  truncation: PulsarMessageId | null;
  high: PulsarMessageId | null;
  pending: PendingInterval | null;
  readonly committed?: PulsarMessageId | null;
  readonly persistentCursor?: PulsarMessageId | null;
  readonly pendingInterval?: PendingInterval | null;
  readonly pendingRange?: PendingInterval | null;
  [key: string]: unknown;
}

export interface PersistStore {
  load?: () => unknown;
  save?: (cursor: PulsarMessageId | null, snapshot: CursorSnapshot) => unknown;
  write?: (cursor: PulsarMessageId | null, snapshot: CursorSnapshot) => unknown;
}

export interface PulsarCursorOptions {
  topic?: string;
  subscription?: string;
  partitionIndex?: number;
  initialPosition?: IdLike | null;
  initialCursor?: IdLike | null;
  startPosition?: IdLike | null;
  startMessageId?: IdLike | null;
  cursor?: IdLike | null;
  committed?: IdLike | null;
  initialLedgerId?: NumericId;
  initialEntryId?: NumericId;
  initialBatchIndex?: number;
  generation?: number;
  inferBatchSize?: boolean;
  persist?: (cursor: PulsarMessageId | null, snapshot: CursorSnapshot) => unknown;
  onPersist?: (cursor: PulsarMessageId | null, snapshot: CursorSnapshot) => unknown;
  persistCursor?: (cursor: PulsarMessageId | null, snapshot: CursorSnapshot) => unknown;
  onCursorChange?: (cursor: PulsarMessageId | null, snapshot: CursorSnapshot) => unknown;
  onCommit?: (cursor: PulsarMessageId | null, snapshot: CursorSnapshot) => unknown;
  store?: PersistStore;
  autoLoad?: boolean;
}

interface ChildState {
  batchIndex: number;
  status: BatchChildStatus;
  seen: boolean;
  attempts: number;
  epoch: number;
  token: string;
}

interface EntryState {
  ledgerId: bigint;
  entryId: bigint;
  partitionIndex?: number;
  batchSize?: number;
  sealed: boolean;
  batch: boolean;
  children: Map<number, ChildState>;
  minIndex: number;
  maxIndex: number;
  epoch: number;
}

interface AckOptions {
  token?: string;
  deliveryToken?: string;
  ackToken?: string;
  generation?: number;
  epoch?: number;
  batchSize?: number;
  [key: string]: unknown;
}

const NON_ENUMERABLE = { enumerable: false, configurable: true };

function defineAlias(target: object, name: string, get: () => unknown): void {
  Object.defineProperty(target, name, {
    ...NON_ENUMERABLE,
    get,
  });
}

function parseInteger(value: unknown, name: string): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw new RangeError(`${name} must be non-negative`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative integer`);
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  throw new TypeError(`${name} must be a bigint, integer, or integer string`);
}

function firstDefined(
  source: Record<string, unknown>,
  names: readonly string[],
): unknown {
  for (const name of names) {
    const value = source[name];
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

interface NormalizedInput {
  id: PulsarMessageId;
  batchSize?: number;
}

function normalizeInput(
  input: IdLike | MessageIdInput | null | undefined,
  entryId?: NumericId,
  batchIndex?: number,
  partitionIndex?: number,
): NormalizedInput {
  if (input === null || input === undefined) {
    throw new TypeError("message id is required");
  }

  if (Array.isArray(input)) {
    if (input.length < 2) {
      throw new TypeError("message id tuple needs ledgerId and entryId");
    }
    const tuplePartition = input[3] === undefined
      ? partitionIndex
      : Number(input[3]);
    if (
      tuplePartition !== undefined &&
      (!Number.isInteger(tuplePartition) || tuplePartition < 0)
    ) {
      throw new RangeError("partitionIndex must be a non-negative integer");
    }
    return {
      id: makePosition(
        parseInteger(input[0], "ledgerId"),
        parseInteger(input[1], "entryId"),
        normalizeBatchIndex(input[2] as number | undefined),
        tuplePartition,
      ),
    };
  }

  if (typeof input === "number" || typeof input === "bigint" || typeof input === "string") {
    const primitive = input as NumericId;
    if (typeof primitive === "string" && primitive.includes(":")) {
      const parts = primitive.split(":");
      if (
        (parts.length === 2 || parts.length === 3 || parts.length === 4) &&
        parts.every((part: string) => /^\d+$/.test(part))
      ) {
        return {
          id: makePosition(
            parseInteger(parts[0], "ledgerId"),
            parseInteger(parts[1], "entryId"),
            normalizeBatchIndex(parts[2] === undefined ? -1 : Number(parts[2])),
            parts[3] === undefined ? partitionIndex : Number(parts[3]),
          ),
        };
      }
    }
    return {
      id: makePosition(
        parseInteger(primitive, "ledgerId"),
        parseInteger(entryId as NumericId, "entryId"),
        normalizeBatchIndex(batchIndex),
        partitionIndex,
      ),
    };
  }

  const source = input as Record<string, unknown>;
  const nested = source.messageId;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return normalizeInput(nested as MessageIdInput, entryId, batchIndex, partitionIndex);
  }

  const ledgerValue = firstDefined(source, [
    "ledgerId",
    "ledger",
    "ledgerID",
    "LedgerId",
  ]);
  const entryValue = firstDefined(source, [
    "entryId",
    "entry",
    "entryID",
    "EntryId",
  ]);
  if (ledgerValue === undefined) {
    throw new TypeError("message id is missing ledgerId");
  }
  if (entryValue === undefined) {
    throw new TypeError("message id is missing entryId");
  }

  const sizeValue = firstDefined(source, ["batchSize", "size", "count"]);
  let batchSize: number | undefined;
  if (sizeValue !== undefined) {
    const parsed = Number(sizeValue);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new RangeError("batchSize must be a positive integer");
    }
    batchSize = parsed;
  }

  let indexValue = firstDefined(source, ["batchIndex", "batch"]);
  if (indexValue === undefined) {
    indexValue = batchIndex;
  }
  let normalizedIndex =
    indexValue === undefined ? -1 : Number(indexValue);

  let partitionValue = firstDefined(source, ["partitionIndex", "partition"]);
  if (partitionValue === undefined) {
    partitionValue = partitionIndex;
  }
  let partition: number | undefined;
  if (partitionValue !== undefined) {
    partition = Number(partitionValue);
    if (!Number.isInteger(partition) || partition < 0) {
      throw new RangeError("partitionIndex must be a non-negative integer");
    }
  }

  return {
    id: makePosition(
      parseInteger(ledgerValue, "ledgerId"),
      parseInteger(entryValue, "entryId"),
      normalizeBatchIndex(normalizedIndex),
      partition,
      batchSize,
    ),
    batchSize,
  };
}

function normalizeBatchIndex(value: number | undefined): number {
  if (value === undefined) {
    return -1;
  }
  if (!Number.isInteger(value) || value < -1) {
    throw new RangeError("batchIndex must be -1 or a non-negative integer");
  }
  return value;
}

function makePosition(
  ledgerId: bigint,
  entryId: bigint,
  batchIndex: number,
  partitionIndex?: number,
  batchSize?: number,
): PulsarMessageId {
  const id: PulsarMessageId = { ledgerId, entryId, batchIndex };
  if (partitionIndex !== undefined) {
    id.partitionIndex = partitionIndex;
  }

  defineAlias(id, "ledger", () => ledgerId);
  defineAlias(id, "entry", () => entryId);
  defineAlias(id, "ledgerID", () => ledgerId);
  defineAlias(id, "entryID", () => entryId);
  defineAlias(id, "LedgerId", () => ledgerId);
  defineAlias(id, "EntryId", () => entryId);
  defineAlias(id, "batch", () => batchIndex);
  defineAlias(id, "partition", () => partitionIndex);
  if (batchSize !== undefined) {
    defineAlias(id, "batchSize", () => batchSize);
    defineAlias(id, "size", () => batchSize);
  }
  defineAlias(id, "toJSON", () => () => serializePosition(id));
  return id;
}

function serializePosition(id: PulsarMessageId): Record<string, unknown> {
  const result: Record<string, unknown> = {
    ledgerId: id.ledgerId.toString(),
    entryId: id.entryId.toString(),
    batchIndex: id.batchIndex,
  };
  if (id.partitionIndex !== undefined) {
    result.partitionIndex = id.partitionIndex;
  }
  if (id.batchSize !== undefined) {
    result.batchSize = id.batchSize;
  }
  return result;
}

function clonePosition(id: PulsarMessageId | null): PulsarMessageId | null {
  if (id === null) {
    return null;
  }
  return makePosition(
    id.ledgerId,
    id.entryId,
    id.batchIndex,
    id.partitionIndex,
    id.batchSize,
  );
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePositions(
  left: PulsarMessageId | null,
  right: PulsarMessageId | null,
): number {
  if (left === null && right === null) {
    return 0;
  }
  if (left === null) {
    return -1;
  }
  if (right === null) {
    return 1;
  }
  const ledger = compareBigInt(left.ledgerId, right.ledgerId);
  if (ledger !== 0) {
    return ledger;
  }
  const entry = compareBigInt(left.entryId, right.entryId);
  if (entry !== 0) {
    return entry;
  }
  const batch = left.batchIndex < right.batchIndex
    ? -1
    : left.batchIndex > right.batchIndex
      ? 1
      : 0;
  if (batch !== 0) {
    return batch;
  }
  const leftPartition = left.partitionIndex ?? 0;
  const rightPartition = right.partitionIndex ?? 0;
  return leftPartition < rightPartition
    ? -1
    : leftPartition > rightPartition
      ? 1
      : 0;
}

function maximumPosition(
  left: PulsarMessageId | null,
  right: PulsarMessageId | null,
): PulsarMessageId | null {
  if (left === null) {
    return clonePosition(right);
  }
  if (right === null) {
    return clonePosition(left);
  }
  return clonePosition(comparePositions(left, right) >= 0 ? left : right);
}

function compareEntry(
  left: { ledgerId: bigint; entryId: bigint; partitionIndex?: number },
  right: { ledgerId: bigint; entryId: bigint; partitionIndex?: number },
): number {
  const ledger = compareBigInt(left.ledgerId, right.ledgerId);
  if (ledger !== 0) {
    return ledger;
  }
  const entry = compareBigInt(left.entryId, right.entryId);
  if (entry !== 0) {
    return entry;
  }
  const leftPartition = left.partitionIndex ?? 0;
  const rightPartition = right.partitionIndex ?? 0;
  return leftPartition < rightPartition
    ? -1
    : leftPartition > rightPartition
      ? 1
      : 0;
}

function entryKey(id: PulsarMessageId): string {
  return `${id.partitionIndex ?? ""}:${id.ledgerId.toString()}:${id.entryId.toString()}`;
}

function positionKey(id: PulsarMessageId): string {
  return `${entryKey(id)}:${id.batchIndex}`;
}

function previousPosition(id: PulsarMessageId): PulsarMessageId | null {
  if (id.batchIndex > 0) {
    return makePosition(id.ledgerId, id.entryId, id.batchIndex - 1, id.partitionIndex);
  }
  if (id.entryId > 0n) {
    return makePosition(id.ledgerId, id.entryId - 1n, -1, id.partitionIndex);
  }
  return null;
}

function isBatchPosition(id: PulsarMessageId): boolean {
  return id.batchIndex >= 0;
}

function isNumericArgument(value: unknown): value is NumericId {
  return typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "string";
}

function normalizeAckCall(
  input: IdLike | MessageIdInput,
  options?: AckOptions | number,
  maybeBatchIndex?: number,
): { id: PulsarMessageId; options?: AckOptions } {
  if (isNumericArgument(options)) {
    return {
      id: normalizeInput(input, options as NumericId, maybeBatchIndex).id,
    };
  }
  return {
    id: normalizeInput(input).id,
    options: options as AckOptions | undefined,
  };
}

function buildUpdate(
  cursor: PulsarMessageId | null,
  pending: PendingInterval | null,
  generation: number,
  values: Partial<CursorUpdate> & { acknowledged?: PulsarMessageId[] },
): CursorUpdate {
  const update: CursorUpdate = {
    accepted: values.accepted ?? true,
    changed: values.changed ?? false,
    advanced: values.advanced ?? false,
    duplicate: values.duplicate ?? false,
    stale: values.stale ?? false,
    truncated: values.truncated ?? false,
    generation,
    cursor,
    pending,
    acknowledged: values.acknowledged ?? [],
  };
  if (values.denied !== undefined) {
    update.denied = values.denied;
  }
  defineAlias(update, "position", () => update.cursor);
  defineAlias(update, "persistentCursor", () => update.cursor);
  defineAlias(update, "committed", () => update.cursor);
  defineAlias(update, "markDeletePosition", () => update.cursor);
  defineAlias(update, "pendingInterval", () => update.pending);
  defineAlias(update, "pendingRange", () => update.pending);
  defineAlias(update, "pendingWindow", () => update.pending);
  defineAlias(update, "next", () => update.pending?.from ?? null);
  defineAlias(update, "last", () => update.pending?.to ?? null);
  defineAlias(update, "acked", () => update.acknowledged);
  defineAlias(update, "acknowledgedIds", () => update.acknowledged);
  defineAlias(update, "deniedIds", () => update.denied);
  return update;
}

function buildInterval(
  from: PulsarMessageId | null,
  to: PulsarMessageId | null,
  positions: PulsarMessageId[],
): PendingInterval | null {
  if (from === null || to === null || comparePositions(from, to) > 0) {
    return null;
  }
  const interval = {
    from: clonePosition(from) as PulsarMessageId,
    to: clonePosition(to) as PulsarMessageId,
  };
  const orderedPositions = positions
    .slice()
    .sort(comparePositions)
    .map((position) => clonePosition(position) as PulsarMessageId);

  defineAlias(interval, "start", () => interval.from);
  defineAlias(interval, "end", () => interval.to);
  defineAlias(interval, "lower", () => interval.from);
  defineAlias(interval, "upper", () => interval.to);
  defineAlias(interval, "first", () => interval.from);
  defineAlias(interval, "last", () => interval.to);
  defineAlias(interval, "min", () => interval.from);
  defineAlias(interval, "max", () => interval.to);
  defineAlias(interval, "next", () => interval.from);
  defineAlias(interval, "high", () => interval.to);
  defineAlias(interval, "nextPosition", () => interval.from);
  defineAlias(interval, "lastPosition", () => interval.to);
  defineAlias(interval, "fromInclusive", () => true);
  defineAlias(interval, "toInclusive", () => true);
  defineAlias(interval, "fromExclusive", () => false);
  defineAlias(interval, "toExclusive", () => false);
  defineAlias(interval, "inclusive", () => true);
  defineAlias(interval, "fromLedgerId", () => interval.from.ledgerId);
  defineAlias(interval, "fromEntryId", () => interval.from.entryId);
  defineAlias(interval, "fromBatchIndex", () => interval.from.batchIndex);
  defineAlias(interval, "toLedgerId", () => interval.to.ledgerId);
  defineAlias(interval, "toEntryId", () => interval.to.entryId);
  defineAlias(interval, "toBatchIndex", () => interval.to.batchIndex);
  defineAlias(interval, "startLedgerId", () => interval.from.ledgerId);
  defineAlias(interval, "startEntryId", () => interval.from.entryId);
  defineAlias(interval, "startBatchIndex", () => interval.from.batchIndex);
  defineAlias(interval, "endLedgerId", () => interval.to.ledgerId);
  defineAlias(interval, "endEntryId", () => interval.to.entryId);
  defineAlias(interval, "endBatchIndex", () => interval.to.batchIndex);
  defineAlias(interval, "positions", () => orderedPositions);
  defineAlias(interval, "count", () => orderedPositions.length);
  defineAlias(interval, "at", () => (index: number) =>
    index === 0 ? interval.from : index === 1 ? interval.to : undefined
  );
  Object.defineProperty(interval, Symbol.iterator, {
    ...NON_ENUMERABLE,
    get: () => function* iterate() {
      yield interval.from;
      yield interval.to;
    },
  });
  defineAlias(interval, "toJSON", () => () => ({
    from: interval.from,
    to: interval.to,
  }));
  return interval as PendingInterval;
}

function buildDelivery(
  id: PulsarMessageId,
  token: string,
  generation: number,
  epoch: number,
  redelivered: boolean,
  terminal: boolean,
): Delivery {
  const delivery: Delivery = {
    id: clonePosition(id) as PulsarMessageId,
    token,
    generation,
    epoch,
    redelivered,
    terminal,
  };
  defineAlias(delivery, "messageId", () => delivery.id);
  defineAlias(delivery, "position", () => delivery.id);
  defineAlias(delivery, "redelivery", () => redelivered);
  defineAlias(delivery, "attempt", () => epoch);
  defineAlias(delivery, "deliveryEpoch", () => epoch);
  defineAlias(delivery, "deliveryGeneration", () => epoch);
  defineAlias(delivery, "ackToken", () => token);
  defineAlias(delivery, "deliveryToken", () => token);
  return delivery;
}

export class PulsarCursor {
  private _generation: number;
  private _cursor: PulsarMessageId | null;
  private _cumulativeAck: PulsarMessageId | null;
  private _truncation: PulsarMessageId | null;
  private _high: PulsarMessageId | null;
  private _entries: Map<string, EntryState>;
  private _inferBatchSize: boolean;
  private _persistCallbacks: Array<
    (cursor: PulsarMessageId | null, snapshot: CursorSnapshot) => unknown
  >;
  private _store: PersistStore | null;

  constructor(
    options?: PulsarCursorOptions | IdLike | null,
    entryId?: NumericId,
    batchIndex?: number,
  ) {
    this._generation = 0;
    this._cursor = null;
    this._cumulativeAck = null;
    this._truncation = null;
    this._high = null;
    this._entries = new Map();
    this._inferBatchSize = false;
    this._persistCallbacks = [];
    this._store = null;

    if (entryId !== undefined) {
      this._cursor = makePosition(
        parseInteger(options as NumericId, "ledgerId"),
        parseInteger(entryId, "entryId"),
        normalizeBatchIndex(batchIndex),
      );
      return;
    }

    if (options === undefined || options === null) {
      return;
    }

    const record = options as Record<string, unknown>;
    const looksLikeOptions =
      typeof options === "object" &&
      !Array.isArray(options) &&
      !("ledgerId" in record) &&
      !("ledger" in record) &&
      !("ledgerID" in record);

    if (!looksLikeOptions) {
      this._cursor = normalizeInput(options as IdLike).id;
      return;
    }

    const opts = options as PulsarCursorOptions;
    if (opts.generation !== undefined) {
      if (!Number.isInteger(opts.generation) || opts.generation < 0) {
        throw new RangeError("generation must be a non-negative integer");
      }
      this._generation = opts.generation;
    }
    this._inferBatchSize = opts.inferBatchSize ?? false;
    this._store = opts.store ?? null;
    for (const callback of [
      opts.persist,
      opts.onPersist,
      opts.persistCursor,
      opts.onCursorChange,
      opts.onCommit,
    ]) {
      if (typeof callback === "function") {
        this._persistCallbacks.push(callback);
      }
    }

    const initial =
      opts.initialPosition ??
      opts.initialCursor ??
      opts.cursor ??
      opts.committed;
    const start = opts.startPosition ?? opts.startMessageId;

    if (
      opts.initialLedgerId !== undefined &&
      opts.initialEntryId !== undefined
    ) {
      this._cursor = makePosition(
        parseInteger(opts.initialLedgerId, "initialLedgerId"),
        parseInteger(opts.initialEntryId, "initialEntryId"),
        normalizeBatchIndex(opts.initialBatchIndex),
      );
    } else if (initial !== undefined && initial !== null) {
      this._cursor = normalizeInput(initial).id;
    } else if (start !== undefined && start !== null) {
      const startId = normalizeInput(start).id;
      this._cursor = this._lastEntryEndBefore(startId);
      if (this._cursor === null && startId.entryId > 0n) {
        this._cursor = makePosition(
          startId.ledgerId,
          startId.entryId - 1n,
          -1,
          startId.partitionIndex,
        );
      }
    }

    if (opts.autoLoad !== false && this._store?.load) {
      const loaded = this._store.load();
      if (loaded !== undefined && loaded !== null) {
        this.restore(loaded as Record<string, unknown>);
      }
    }
  }

  static fromSnapshot(
    snapshot: CursorSnapshot | Record<string, unknown> | string,
    options?: Omit<PulsarCursorOptions, "initialPosition" | "initialCursor" | "cursor" | "committed">,
  ): PulsarCursor {
    const cursor = new PulsarCursor({ ...(options ?? {}), autoLoad: false });
    cursor.restore(snapshot);
    return cursor;
  }

  static deserialize(
    snapshot: CursorSnapshot | Record<string, unknown> | string,
    options?: Omit<PulsarCursorOptions, "initialPosition" | "initialCursor" | "cursor" | "committed">,
  ): PulsarCursor {
    return PulsarCursor.fromSnapshot(snapshot, options);
  }

  get generation(): number {
    return this._generation;
  }

  get cursor(): PulsarMessageId | null {
    return clonePosition(this._cursor);
  }

  get committed(): PulsarMessageId | null {
    return clonePosition(this._cursor);
  }

  get persistentCursor(): PulsarMessageId | null {
    return clonePosition(this._cursor);
  }

  get markDeletePosition(): PulsarMessageId | null {
    return clonePosition(this._cursor);
  }

  get lastAcknowledged(): PulsarMessageId | null {
    return clonePosition(this._cursor);
  }

  get lastAck(): PulsarMessageId | null {
    return clonePosition(this._cursor);
  }

  get position(): PulsarMessageId | null {
    return clonePosition(this._cursor);
  }

  get cumulativeAck(): PulsarMessageId | null {
    return clonePosition(this._cumulativeAck);
  }

  get truncation(): PulsarMessageId | null {
    return clonePosition(this._truncation);
  }

  get highWatermark(): PulsarMessageId | null {
    return clonePosition(this._high);
  }

  get high(): PulsarMessageId | null {
    return clonePosition(this._high);
  }

  get pending(): PendingInterval | null {
    return this.getPendingInterval();
  }

  get pendingWindow(): PendingInterval | null {
    return this.getPendingInterval();
  }

  get pendingCount(): number {
    return this.getPendingMessages().length;
  }

  get nextPosition(): PulsarMessageId | null {
    return this.getPendingInterval()?.from ?? null;
  }

  get readPosition(): PulsarMessageId | null {
    return this._cursor;
  }

  get isCaughtUp(): boolean {
    return this.getPendingInterval() === null && this._high !== null;
  }

  getCursor(): PulsarMessageId | null {
    return clonePosition(this._cursor);
  }

  getCommitted(): PulsarMessageId | null {
    return clonePosition(this._cursor);
  }

  getPersistentCursor(): PulsarMessageId | null {
    return clonePosition(this._cursor);
  }

  getPosition(): PulsarMessageId | null {
    return clonePosition(this._cursor);
  }

  getNextPosition(): PulsarMessageId | null {
    return this.getPendingInterval()?.from ?? null;
  }

  getTruncation(): PulsarMessageId | null {
    return clonePosition(this._truncation);
  }

  getGeneration(): number {
    return this._generation;
  }

  observe(
    input: IdLike | MessageIdInput,
    entryId?: NumericId,
    batchIndex?: number,
  ): Delivery {
    const normalized = normalizeInput(input, entryId, batchIndex);
    const id = normalized.id;
    const previousCursor = this._cursor;
    const entry = this._ensureEntry(id, normalized.batchSize);
    this._ensureChild(entry, id.batchIndex);
    this._raiseHigh(entry);
    this._advance();
    this._persistIfChanged(previousCursor);
    const child = entry.children.get(id.batchIndex) as ChildState;
    const terminal = this._childTerminal(entry, id.batchIndex);
    return buildDelivery(
      id,
      child.token,
      this._generation,
      child.epoch,
      false,
      terminal,
    );
  }

  register(
    input: IdLike | MessageIdInput,
    entryId?: NumericId,
    batchIndex?: number,
  ): Delivery {
    return this.observe(input, entryId, batchIndex);
  }

  deliver(
    input: IdLike | MessageIdInput,
    entryId?: NumericId,
    batchIndex?: number,
  ): Delivery {
    return this.observe(input, entryId, batchIndex);
  }

  track(
    input: IdLike | MessageIdInput,
    entryId?: NumericId,
    batchIndex?: number,
  ): Delivery {
    return this.observe(input, entryId, batchIndex);
  }

  acknowledge(
    input: IdLike | MessageIdInput,
    options?: AckOptions | number,
    maybeBatchIndex?: number,
  ): CursorUpdate {
    let normalized: NormalizedInput;
    if (isNumericArgument(options) && maybeBatchIndex !== undefined) {
      normalized = normalizeInput(input, options as NumericId, maybeBatchIndex);
    } else if (isNumericArgument(options) && maybeBatchIndex === undefined) {
      normalized = normalizeInput(input, options as NumericId);
    } else {
      normalized = normalizeInput(input);
    }
    const ackOptions = typeof options === "object" && options !== null
      ? options as AckOptions
      : undefined;
    return this._acknowledgeIndividual(normalized.id, ackOptions);
  }

  ack(
    input: IdLike | MessageIdInput,
    options?: AckOptions | number,
    maybeBatchIndex?: number,
  ): CursorUpdate {
    return this.acknowledge(input, options, maybeBatchIndex);
  }

  acknowledgeIndividual(
    input: IdLike | MessageIdInput,
    options?: AckOptions | number,
    maybeBatchIndex?: number,
  ): CursorUpdate {
    const call = normalizeAckCall(input, options, maybeBatchIndex);
    return this._acknowledgeIndividual(call.id, call.options);
  }

  individualAcknowledge(
    input: IdLike | MessageIdInput,
    options?: AckOptions | number,
    maybeBatchIndex?: number,
  ): CursorUpdate {
    const call = normalizeAckCall(input, options, maybeBatchIndex);
    return this._acknowledgeIndividual(call.id, call.options);
  }

  individualAck(
    input: IdLike | MessageIdInput,
    options?: AckOptions | number,
    maybeBatchIndex?: number,
  ): CursorUpdate {
    const call = normalizeAckCall(input, options, maybeBatchIndex);
    return this._acknowledgeIndividual(call.id, call.options);
  }

  ackMessage(
    input: IdLike | MessageIdInput,
    options?: AckOptions | number,
    maybeBatchIndex?: number,
  ): CursorUpdate {
    const call = normalizeAckCall(input, options, maybeBatchIndex);
    return this._acknowledgeIndividual(call.id, call.options);
  }

  acknowledgeCumulative(
    input: IdLike | MessageIdInput,
    options?: AckOptions | number,
    maybeBatchIndex?: number,
  ): CursorUpdate {
    const call = normalizeAckCall(input, options, maybeBatchIndex);
    return this._acknowledgeCumulative(call.id, call.options);
  }

  cumulativeAcknowledge(
    input: IdLike | MessageIdInput,
    options?: AckOptions | number,
    maybeBatchIndex?: number,
  ): CursorUpdate {
    const call = normalizeAckCall(input, options, maybeBatchIndex);
    return this._acknowledgeCumulative(call.id, call.options);
  }

  ackCumulative(
    input: IdLike | MessageIdInput,
    options?: AckOptions | number,
    maybeBatchIndex?: number,
  ): CursorUpdate {
    const call = normalizeAckCall(input, options, maybeBatchIndex);
    return this._acknowledgeCumulative(call.id, call.options);
  }

  negativeAcknowledge(
    input: IdLike | MessageIdInput,
    options?: AckOptions | number,
    maybeBatchIndex?: number,
  ): CursorUpdate {
    const call = normalizeAckCall(input, options, maybeBatchIndex);
    return this._negativeAcknowledge(call.id, call.options);
  }

  negativeAck(
    input: IdLike | MessageIdInput,
    options?: AckOptions | number,
    maybeBatchIndex?: number,
  ): CursorUpdate {
    const call = normalizeAckCall(input, options, maybeBatchIndex);
    return this._negativeAcknowledge(call.id, call.options);
  }

  nack(
    input: IdLike | MessageIdInput,
    options?: AckOptions | number,
    maybeBatchIndex?: number,
  ): CursorUpdate {
    const call = normalizeAckCall(input, options, maybeBatchIndex);
    return this._negativeAcknowledge(call.id, call.options);
  }

  deny(
    input: IdLike | MessageIdInput,
    options?: AckOptions | number,
    maybeBatchIndex?: number,
  ): CursorUpdate {
    const call = normalizeAckCall(input, options, maybeBatchIndex);
    return this._negativeAcknowledge(call.id, call.options);
  }

  denyMessage(
    input: IdLike | MessageIdInput,
    options?: AckOptions | number,
    maybeBatchIndex?: number,
  ): CursorUpdate {
    const call = normalizeAckCall(input, options, maybeBatchIndex);
    return this._negativeAcknowledge(call.id, call.options);
  }

  redeliver(
    input: IdLike | MessageIdInput,
    entryId?: NumericId,
    batchIndex?: number,
  ): Delivery {
    const normalized = normalizeInput(input, entryId, batchIndex);
    const id = normalized.id;
    if (
      this._truncation !== null &&
      comparePositions(id, this._truncation) <= 0
    ) {
      throw new RangeError("message is before the topic truncation point");
    }

    this._generation += 1;
    const entry = this._ensureEntry(id, normalized.batchSize);
    let child: ChildState;
    if (entry.batch && id.batchIndex === -1) {
      let indexes = this._entryIndexes(entry);
      if (indexes.length === 0 && entry.batchSize !== undefined) {
        indexes = Array.from({ length: entry.batchSize }, (_, index) => index);
      }
      if (indexes.length === 0) {
        indexes = [0];
      }
      let first: ChildState | null = null;
      for (const index of indexes) {
        const reopened = this._ensureChild(entry, index);
        reopened.status = "pending";
        reopened.attempts += 1;
        reopened.epoch += 1;
        reopened.token = this._makeToken(entry, reopened);
        first ??= reopened;
      }
      child = first as ChildState;
    } else {
      child = this._ensureChild(entry, id.batchIndex);
      child.status = "pending";
      child.attempts += 1;
      child.epoch += 1;
      child.token = this._makeToken(entry, child);
    }
    entry.epoch += 1;

    if (
      this._cumulativeAck !== null &&
      comparePositions(id, this._cumulativeAck) <= 0
    ) {
      this._cumulativeAck = previousPosition(id);
    }

    const previousCursor = this._cursor;
    if (
      this._cursor !== null &&
      compareEntry(this._cursor, id) >= 0
    ) {
      this._cursor = this._lastEntryEndBefore(id);
    }
    this._raiseHigh(entry);
    this._persistIfChanged(previousCursor);

    return buildDelivery(
      id,
      child.token,
      this._generation,
      child.epoch,
      true,
      false,
    );
  }

  markRedelivered(
    input: IdLike | MessageIdInput,
    entryId?: NumericId,
    batchIndex?: number,
  ): Delivery {
    return this.redeliver(input, entryId, batchIndex);
  }

  replay(
    input: IdLike | MessageIdInput,
    entryId?: NumericId,
    batchIndex?: number,
  ): Delivery {
    return this.redeliver(input, entryId, batchIndex);
  }

  rollback(
    target?: IdLike | MessageIdInput | null,
    options?: { inclusive?: boolean },
  ): CursorUpdate {
    const previousCursor = this._cursor;

    if (target === undefined || target === null) {
      this._generation += 1;
      this._cursor = clonePosition(this._truncation);
      this._cumulativeAck = null;
      for (const entry of this._entries.values()) {
        entry.epoch += 1;
        for (const child of entry.children.values()) {
          if (child.status !== "truncated") {
            child.status = "pending";
            child.attempts += 1;
            child.epoch += 1;
            child.token = this._makeToken(entry, child);
          }
        }
      }
      this._persistIfChanged(previousCursor);
      return this._buildUpdate({
        changed: previousCursor !== null,
        advanced: false,
        acknowledged: [],
      });
    }

    const targetId = normalizeInput(target).id;
    const inclusive = options?.inclusive ?? true;
    const replayFrom = inclusive ? targetId : this._nextLogicalPosition(targetId);

    if (
      this._truncation !== null &&
      comparePositions(replayFrom, this._truncation) <= 0
    ) {
      return this._buildUpdate({
        accepted: false,
        truncated: true,
      });
    }
    if (replayFrom === null) {
      return this._buildUpdate({ accepted: false });
    }

    this._generation += 1;
    if (
      this._cumulativeAck !== null &&
      comparePositions(replayFrom, this._cumulativeAck) <= 0
    ) {
      this._cumulativeAck = previousPosition(replayFrom);
    }

    for (const entry of this._entries.values()) {
      let reopened = false;
      for (const child of entry.children.values()) {
        const childId = makePosition(
          entry.ledgerId,
          entry.entryId,
          child.batchIndex,
          entry.partitionIndex,
        );
        if (
          comparePositions(childId, replayFrom) >= 0 &&
          child.status !== "truncated"
        ) {
          child.status = "pending";
          child.attempts += 1;
          child.epoch += 1;
          child.token = this._makeToken(entry, child);
          reopened = true;
        }
      }
      if (reopened) {
        entry.epoch += 1;
      }
    }

    const before = this._lastEntryEndBefore(replayFrom);
    const truncationCursor =
      this._truncation !== null &&
      comparePositions(this._truncation, replayFrom) < 0
        ? this._truncation
        : null;
    this._cursor = maximumPosition(before, truncationCursor);
    this._persistIfChanged(previousCursor);

    return this._buildUpdate({
      changed: comparePositions(previousCursor, this._cursor) !== 0,
      advanced: false,
      acknowledged: [],
    });
  }

  rewind(
    target?: IdLike | MessageIdInput | null,
    options?: { inclusive?: boolean },
  ): CursorUpdate {
    return this.rollback(target, options);
  }

  seek(
    target: IdLike | MessageIdInput,
    options?: { inclusive?: boolean },
  ): CursorUpdate {
    return this.rollback(target, options);
  }

  reset(target?: IdLike | MessageIdInput | null): CursorUpdate {
    return this.rollback(target);
  }

  truncate(
    input: IdLike | MessageIdInput,
    options?: { inclusive?: boolean },
  ): CursorUpdate {
    const id = normalizeInput(input).id;
    const previousCursor = this._cursor;
    const inclusive = options?.inclusive ?? true;
    const watermark = inclusive ? id : previousPosition(id);

    if (watermark === null) {
      return this._buildUpdate({ accepted: false });
    }
    this._truncation = maximumPosition(this._truncation, watermark);
    this._cumulativeAck = maximumPosition(this._cumulativeAck, watermark);
    this._high = maximumPosition(this._high, watermark);

    for (const entry of this._entries.values()) {
      this._applyTruncation(entry);
    }

    if (
      this._cursor === null ||
      comparePositions(this._cursor, watermark) < 0
    ) {
      this._cursor = clonePosition(watermark);
    }

    this._advance();
    this._persistIfChanged(previousCursor);
    return this._buildUpdate({
      changed: comparePositions(previousCursor, this._cursor) !== 0,
      advanced: comparePositions(previousCursor, this._cursor) < 0,
      truncated: true,
      acknowledged: [],
    });
  }

  truncateTopic(
    input: IdLike | MessageIdInput,
    options?: { inclusive?: boolean },
  ): CursorUpdate {
    return this.truncate(input, options);
  }

  truncateBefore(
    input: IdLike | MessageIdInput,
  ): CursorUpdate {
    return this.truncate(input, { inclusive: false });
  }

  onTruncate(
    input: IdLike | MessageIdInput,
    options?: { inclusive?: boolean },
  ): CursorUpdate {
    return this.truncate(input, options);
  }

  handleTruncation(
    input: IdLike | MessageIdInput,
    options?: { inclusive?: boolean },
  ): CursorUpdate {
    return this.truncate(input, options);
  }

  registerBatch(
    input: IdLike | MessageIdInput,
    batchSize: number,
  ): BatchState {
    const normalized = normalizeInput(input);
    const size = Number(batchSize);
    if (!Number.isInteger(size) || size < 1) {
      throw new RangeError("batchSize must be a positive integer");
    }
    const previousCursor = this._cursor;
    const entry = this._ensureEntry(normalized.id, size);
    if (entry.batchSize !== undefined && entry.batchSize !== size) {
      throw new RangeError("batchSize conflicts with the registered batch");
    }
    entry.batchSize = size;
    entry.batch = true;
    if (entry.maxIndex < 0) {
      entry.maxIndex = size - 1;
    }
    this._raiseHigh(entry);
    this._advance();
    this._persistIfChanged(previousCursor);
    return this.getBatchState(normalized.id);
  }

  trackBatch(
    input: IdLike | MessageIdInput,
    batchSize: number,
  ): BatchState {
    return this.registerBatch(input, batchSize);
  }

  beginBatch(
    input: IdLike | MessageIdInput,
    batchSize: number,
  ): BatchState {
    return this.registerBatch(input, batchSize);
  }

  setBatchSize(
    input: IdLike | MessageIdInput,
    batchSize: number,
  ): BatchState {
    return this.registerBatch(input, batchSize);
  }

  sealBatch(
    input: IdLike | MessageIdInput,
    batchSize?: number,
  ): BatchState {
    const normalized = normalizeInput(input);
    const previousCursor = this._cursor;
    const entry = this._ensureEntry(normalized.id, batchSize);
    if (
      batchSize !== undefined &&
      entry.batchSize !== undefined &&
      entry.batchSize !== batchSize
    ) {
      throw new RangeError("batchSize conflicts with the registered batch");
    }
    if (batchSize !== undefined) {
      entry.batchSize = batchSize;
    }
    entry.batch = true;
    entry.sealed = true;
    if (entry.maxIndex < 0 && entry.batchSize !== undefined) {
      entry.maxIndex = entry.batchSize - 1;
    }
    this._raiseHigh(entry);
    this._advance();
    this._persistIfChanged(previousCursor);
    return this.getBatchState(normalized.id);
  }

  completeBatch(
    input: IdLike | MessageIdInput,
    batchSize?: number,
  ): BatchState {
    return this.sealBatch(input, batchSize);
  }

  acknowledgeBatch(
    input: IdLike | MessageIdInput,
    indexesOrSize?: number[] | number,
    options?: AckOptions,
  ): CursorUpdate {
    const normalized = normalizeInput(input);
    let entry = this._ensureEntry(normalized.id, normalized.batchSize);
    const acknowledged: PulsarMessageId[] = [];
    let changed = false;
    let duplicate = true;
    const previousCursor = this._cursor;

    let indexes: number[];
    if (Array.isArray(indexesOrSize)) {
      indexes = indexesOrSize.map((index) => Number(index));
    } else {
      let size = entry.batchSize;
      if (typeof indexesOrSize === "number") {
        size = Number(indexesOrSize);
        if (!Number.isInteger(size) || size < 1) {
          throw new RangeError("batchSize must be a positive integer");
        }
        entry = this._ensureEntry(normalized.id, size);
        entry.batchSize = size;
        entry.batch = true;
      }
      if (size === undefined) {
        indexes = Array.from(entry.children.keys());
      } else {
        indexes = Array.from({ length: size }, (_, index) => index);
      }
    }

    for (const index of indexes) {
      const childId = makePosition(
        normalized.id.ledgerId,
        normalized.id.entryId,
        index,
        normalized.id.partitionIndex,
      );
      const result = this._acknowledgeIndividual(childId, options, true);
      changed = changed || result.changed;
      if (!result.duplicate) {
        duplicate = false;
      }
      if (result.changed) {
        acknowledged.push(childId);
      }
    }

    const advanced = comparePositions(previousCursor, this._cursor) < 0;
    this._persistIfChanged(previousCursor);
    return this._buildUpdate({
      changed,
      advanced,
      duplicate: duplicate && acknowledged.length === 0,
      acknowledged,
    });
  }

  ackBatch(
    input: IdLike | MessageIdInput,
    indexesOrSize?: number[] | number,
    options?: AckOptions,
  ): CursorUpdate {
    return this.acknowledgeBatch(input, indexesOrSize, options);
  }

  getBatchState(input: IdLike | MessageIdInput): BatchState {
    const id = normalizeInput(input).id;
    const entry = this._entries.get(entryKey(id));
    if (entry === undefined) {
      const knownSize = id.batchSize;
      const result: BatchState = {
        id,
        batchSize: knownSize ?? null,
        sealed: false,
        acknowledged: [],
        pending: knownSize === undefined
          ? []
          : Array.from({ length: knownSize }, (_, index) => index),
        denied: [],
        complete: false,
      };
      defineAlias(result, "isComplete", () => result.complete);
      return result;
    }

    const acknowledged: number[] = [];
    const pending: number[] = [];
    const denied: number[] = [];
    const children = entry.batch && entry.batchSize !== undefined
      ? Array.from({ length: entry.batchSize }, (_, index) => index)
      : Array.from(entry.children.keys()).sort((a, b) => a - b);
    for (const index of children) {
      const child = entry.children.get(index);
      if (child === undefined) {
        pending.push(index);
        continue;
      }
      if (child.status === "acked" || child.status === "truncated") {
        acknowledged.push(index);
      } else if (child.status === "denied") {
        denied.push(index);
      } else {
        pending.push(index);
      }
    }

    const result: BatchState = {
      id,
      batchSize: entry.batchSize ?? null,
      sealed: entry.sealed,
      acknowledged,
      pending,
      denied,
      complete: this._entryFullyDone(entry),
    };
    defineAlias(result, "isComplete", () => result.complete);
    return result;
  }

  batchState(input: IdLike | MessageIdInput): BatchState {
    return this.getBatchState(input);
  }

  isAcknowledged(
    input: IdLike | MessageIdInput,
    options?: AckOptions,
  ): boolean {
    const id = normalizeInput(input).id;
    const entry = this._entries.get(entryKey(id));
    if (entry !== undefined && entry.batch && id.batchIndex === -1) {
      return this._entryFullyDone(entry);
    }
    if (this._truncation !== null && comparePositions(id, this._truncation) <= 0) {
      return true;
    }
    if (this._cumulativeAck !== null && comparePositions(id, this._cumulativeAck) <= 0) {
      return true;
    }
    if (this._cursor !== null && comparePositions(id, this._cursor) <= 0) {
      return true;
    }
    if (entry === undefined) {
      return false;
    }
    const child = entry.children.get(id.batchIndex);
    if (child === undefined) {
      return false;
    }
    if (options?.token !== undefined && child.token !== options.token) {
      return false;
    }
    return this._childTerminal(entry, id.batchIndex);
  }

  isPending(input: IdLike | MessageIdInput): boolean {
    const id = normalizeInput(input).id;
    if (this.isAcknowledged(id)) {
      return false;
    }
    const entry = this._entries.get(entryKey(id));
    if (entry === undefined) {
      return false;
    }
    return !this._childTerminal(entry, id.batchIndex);
  }

  isTruncated(input: IdLike | MessageIdInput): boolean {
    const id = normalizeInput(input).id;
    const entry = this._entries.get(entryKey(id));
    if (entry !== undefined && entry.batch && id.batchIndex === -1) {
      return this._truncation !== null &&
        comparePositions(this._entryEnd(entry), this._truncation) <= 0;
    }
    return this._truncation !== null && comparePositions(id, this._truncation) <= 0;
  }

  isTerminal(input: IdLike | MessageIdInput): boolean {
    return this.isAcknowledged(input);
  }

  getPendingInterval(): PendingInterval | null {
    const unresolved = this._collectUnresolved();
    const high = this._effectiveHigh();

    let from: PulsarMessageId | null = null;
    if (unresolved.length > 0) {
      from = unresolved[0];
    }

    const base = this._pendingBase();
    if (base !== null && (from === null || compareEntry(base, from) < 0)) {
      from = base;
    }

    let to: PulsarMessageId | null = high;
    if (unresolved.length > 0) {
      const lastUnresolved = unresolved[unresolved.length - 1];
      to = maximumPosition(to, lastUnresolved);
    }

    if (
      from !== null &&
      to !== null &&
      comparePositions(to, from) < 0
    ) {
      to = clonePosition(from);
    }
    if (from === null || to === null) {
      return null;
    }
    if (
      this._truncation !== null &&
      comparePositions(from, this._truncation) <= 0
    ) {
      from = this._nextLogicalPosition(this._truncation);
    }
    if (from === null || comparePositions(from, to) > 0) {
      return null;
    }
    return buildInterval(from, to, unresolved);
  }

  getPendingRange(): PendingInterval | null {
    return this.getPendingInterval();
  }

  pendingRange(): PendingInterval | null {
    return this.getPendingInterval();
  }

  pendingInterval(): PendingInterval | null {
    return this.getPendingInterval();
  }

  getPendingWindow(): PendingInterval | null {
    return this.getPendingInterval();
  }

  getPending(): PendingInterval | null {
    return this.getPendingInterval();
  }

  getPendingMessages(): PulsarMessageId[] {
    return this._collectUnresolved().map((id) => clonePosition(id) as PulsarMessageId);
  }

  pendingMessages(): PulsarMessageId[] {
    return this.getPendingMessages();
  }

  getUnacked(): PulsarMessageId[] {
    return this.getPendingMessages();
  }

  unacked(): PulsarMessageId[] {
    return this.getPendingMessages();
  }

  getPendingRanges(): PendingInterval[] {
    const unresolved = this._collectUnresolved();
    if (unresolved.length === 0) {
      const interval = this.getPendingInterval();
      return interval === null ? [] : [interval];
    }

    const ranges: PendingInterval[] = [];
    let start = unresolved[0];
    let previous = unresolved[0];
    for (let index = 1; index < unresolved.length; index += 1) {
      const current = unresolved[index];
      if (this._areAdjacent(previous, current)) {
        previous = current;
        continue;
      }
      const range = buildInterval(start, previous, this._positionsBetween(start, previous));
      if (range !== null) {
        ranges.push(range);
      }
      start = current;
      previous = current;
    }
    const last = buildInterval(start, previous, this._positionsBetween(start, previous));
    if (last !== null) {
      ranges.push(last);
    }
    return ranges;
  }

  getPendingIntervals(): PendingInterval[] {
    return this.getPendingRanges();
  }

  pendingRanges(): PendingInterval[] {
    return this.getPendingRanges();
  }

  snapshot(): CursorSnapshot {
    const entries: EntrySnapshot[] = [];
    for (const entry of this._sortedEntries()) {
      const children: EntrySnapshot["children"] = [];
      for (const child of entry.children.values()) {
        children.push({
          batchIndex: child.batchIndex,
          status: child.status,
          seen: child.seen,
          attempts: child.attempts,
          epoch: child.epoch,
        });
      }
      children.sort((left, right) => left.batchIndex - right.batchIndex);
      entries.push({
        id: makePosition(
          entry.ledgerId,
          entry.entryId,
          entry.batch ? 0 : -1,
          entry.partitionIndex,
          entry.batchSize,
        ),
        ...(entry.batchSize !== undefined ? { batchSize: entry.batchSize } : {}),
        sealed: entry.sealed,
        batch: entry.batch,
        children,
      });
    }

    return {
      version: 1,
      generation: this._generation,
      cursor: clonePosition(this._cursor),
      cumulativeAck: clonePosition(this._cumulativeAck),
      truncation: clonePosition(this._truncation),
      high: clonePosition(this._high),
      entries,
    };
  }

  getSnapshot(): CursorSnapshot {
    return this.snapshot();
  }

  checkpoint(): CursorSnapshot {
    return this.snapshot();
  }

  save(): CursorSnapshot {
    return this.snapshot();
  }

  exportSnapshot(): CursorSnapshot {
    return this.snapshot();
  }

  importSnapshot(
    snapshot: CursorSnapshot | Record<string, unknown> | string,
  ): this {
    return this.restore(snapshot);
  }

  state(): CursorState {
    const result: CursorState = {
      generation: this._generation,
      cursor: clonePosition(this._cursor),
      cumulativeAck: clonePosition(this._cumulativeAck),
      truncation: clonePosition(this._truncation),
      high: clonePosition(this._high),
      pending: this.getPendingInterval(),
    };
    defineAlias(result, "committed", () => result.cursor);
    defineAlias(result, "persistentCursor", () => result.cursor);
    defineAlias(result, "pendingInterval", () => result.pending);
    defineAlias(result, "pendingRange", () => result.pending);
    return result;
  }

  getState(): CursorState {
    return this.state();
  }

  serialize(): string {
    return JSON.stringify(this.snapshot());
  }

  toJSON(): CursorSnapshot {
    return this.snapshot();
  }

  restore(snapshot: CursorSnapshot | Record<string, unknown> | string): this {
    const parsed = typeof snapshot === "string"
      ? JSON.parse(snapshot) as Record<string, unknown>
      : snapshot as unknown as Record<string, unknown>;

    this._entries.clear();
    this._cursor = null;
    this._cumulativeAck = null;
    this._truncation = null;
    this._high = null;
    this._generation = 0;

    if (typeof parsed.generation === "number" && parsed.generation >= 0) {
      this._generation = parsed.generation;
    }

    const cursorValue =
      parsed.cursor ?? parsed.committed ?? parsed.persistentCursor ?? parsed.position;
    if (cursorValue !== undefined && cursorValue !== null) {
      this._cursor = normalizeInput(cursorValue as IdLike).id;
    }
    const cumulativeValue = parsed.cumulativeAck ?? parsed.cumulative;
    if (cumulativeValue !== undefined && cumulativeValue !== null) {
      this._cumulativeAck = normalizeInput(cumulativeValue as IdLike).id;
    }
    const truncationValue = parsed.truncation ?? parsed.truncatedThrough;
    if (truncationValue !== undefined && truncationValue !== null) {
      this._truncation = normalizeInput(truncationValue as IdLike).id;
    }
    const highValue = parsed.high ?? parsed.highWatermark;
    if (highValue !== undefined && highValue !== null) {
      this._high = normalizeInput(highValue as IdLike).id;
    }

    const rawEntries = parsed.entries;
    if (Array.isArray(rawEntries)) {
      for (const raw of rawEntries) {
        if (raw === null || typeof raw !== "object") {
          continue;
        }
        const source = raw as Record<string, unknown>;
        const idValue = source.id ?? source;
        let id: PulsarMessageId;
        try {
          id = normalizeInput(idValue as IdLike).id;
        } catch {
          continue;
        }
        const sizeValue = source.batchSize;
        const batchSize = sizeValue === undefined ? undefined : Number(sizeValue);
        const entry = this._ensureEntry(id, Number.isInteger(batchSize) ? batchSize : undefined);
        entry.sealed = Boolean(source.sealed);
        entry.batch = source.batch === undefined ? entry.batch : Boolean(source.batch);
        if (Number.isInteger(batchSize) && (batchSize as number) > 0) {
          entry.batchSize = batchSize as number;
        }

        const rawChildren = source.children;
        if (Array.isArray(rawChildren)) {
          for (const rawChild of rawChildren) {
            if (rawChild === null || typeof rawChild !== "object") {
              continue;
            }
            const childSource = rawChild as Record<string, unknown>;
            const index = Number(childSource.batchIndex);
            if (!Number.isInteger(index) || index < -1) {
              continue;
            }
            if (
              entry.batchSize !== undefined &&
              index >= entry.batchSize &&
              index >= 0
            ) {
              continue;
            }
            const child = this._ensureChild(entry, index);
            const status = childSource.status;
            if (
              status === "pending" ||
              status === "acked" ||
              status === "denied" ||
              status === "truncated"
            ) {
              child.status = status;
            }
            child.seen = childSource.seen === undefined
              ? true
              : Boolean(childSource.seen);
            child.attempts = Number.isInteger(childSource.attempts)
              ? Number(childSource.attempts)
              : child.attempts;
            child.epoch = Number.isInteger(childSource.epoch)
              ? Number(childSource.epoch)
              : child.epoch;
            child.token = this._makeToken(entry, child);
          }
        }
        this._raiseHigh(entry);
      }
    }

    this._advance();
    return this;
  }

  load(snapshot: CursorSnapshot | Record<string, unknown> | string): this {
    return this.restore(snapshot);
  }

  persistNow(): CursorSnapshot {
    const snapshot = this.snapshot();
    for (const callback of this._persistCallbacks) {
      callback(clonePosition(this._cursor), snapshot);
    }
    if (this._store !== null) {
      if (typeof this._store.save === "function") {
        this._store.save(clonePosition(this._cursor), snapshot);
      } else if (typeof this._store.write === "function") {
        this._store.write(clonePosition(this._cursor), snapshot);
      }
    }
    return snapshot;
  }

  flush(): CursorSnapshot {
    return this.persistNow();
  }

  persist(): CursorSnapshot {
    return this.persistNow();
  }

  private _acknowledgeIndividual(
    id: PulsarMessageId,
    options?: AckOptions,
    skipPersist = false,
  ): CursorUpdate {
    const stale = this._checkToken(id, options);
    if (stale) {
      return this._buildUpdate({
        accepted: false,
        stale: true,
      });
    }

    if (
      this._truncation !== null &&
      comparePositions(id, this._truncation) <= 0
    ) {
      return this._buildUpdate({
        accepted: true,
        duplicate: true,
        truncated: true,
      });
    }

    const normalized = normalizeInput(id);
    const optionBatchSize = typeof options?.batchSize === "number"
      ? options.batchSize
      : undefined;
    const entry = this._ensureEntry(id, normalized.batchSize ?? optionBatchSize);
    const previousCursor = this._cursor;

    if (entry.batch && id.batchIndex === -1) {
      return this._acknowledgeWholeEntry(entry, skipPersist);
    }

    const child = this._ensureChild(entry, id.batchIndex);
    const covered =
      (this._cumulativeAck !== null &&
        comparePositions(id, this._cumulativeAck) <= 0) ||
      (this._cursor !== null && comparePositions(id, this._cursor) <= 0);

    if (child.status === "acked" || child.status === "truncated" || covered) {
      child.status = "acked";
      this._raiseHigh(entry);
      const advanced = this._advance();
      if (!skipPersist) {
        this._persistIfChanged(previousCursor);
      }
      return this._buildUpdate({
        changed: advanced,
        advanced,
        duplicate: true,
        acknowledged: [],
      });
    }

    child.status = "acked";
    this._raiseHigh(entry);
    const advanced = this._advance();
    if (!skipPersist) {
      this._persistIfChanged(previousCursor);
    }
    return this._buildUpdate({
      changed: true,
      advanced,
      duplicate: false,
      acknowledged: [clonePosition(id) as PulsarMessageId],
    });
  }

  private _acknowledgeWholeEntry(
    entry: EntryState,
    skipPersist = false,
  ): CursorUpdate {
    const previousCursor = this._cursor;
    const acknowledged: PulsarMessageId[] = [];
    let changed = false;
    const indexes = this._entryIndexes(entry);
    if (indexes.length === 0) {
      if (entry.batch && entry.batchSize !== undefined) {
        for (let index = 0; index < entry.batchSize; index += 1) {
          indexes.push(index);
        }
      } else {
        indexes.push(-1);
      }
    }

    for (const index of indexes) {
      const child = this._ensureChild(entry, index);
      if (child.status !== "acked") {
        child.status = "acked";
        acknowledged.push(
          makePosition(entry.ledgerId, entry.entryId, index, entry.partitionIndex),
        );
        changed = true;
      }
    }
    entry.sealed = true;
    this._raiseHigh(entry);
    const advanced = this._advance();
    if (!skipPersist) {
      this._persistIfChanged(previousCursor);
    }
    return this._buildUpdate({
      changed: changed || advanced,
      advanced,
      duplicate: !changed && !advanced,
      acknowledged,
    });
  }

  private _acknowledgeCumulative(
    id: PulsarMessageId,
    options?: AckOptions,
  ): CursorUpdate {
    const stale = this._checkToken(id, options);
    if (stale) {
      return this._buildUpdate({
        accepted: false,
        stale: true,
      });
    }

    if (
      this._truncation !== null &&
      comparePositions(id, this._truncation) <= 0
    ) {
      return this._buildUpdate({
        accepted: true,
        duplicate: true,
        truncated: true,
      });
    }

    const previousCursor = this._cursor;
    const previousCumulative = this._cumulativeAck;
    const duplicate =
      (previousCumulative !== null &&
        comparePositions(id, previousCumulative) <= 0) ||
      (previousCursor !== null &&
        comparePositions(id, previousCursor) <= 0);

    const normalized = normalizeInput(id);
    const optionBatchSize = typeof options?.batchSize === "number"
      ? options.batchSize
      : undefined;
    this._ensureEntry(id, normalized.batchSize ?? optionBatchSize);
    this._cumulativeAck = maximumPosition(this._cumulativeAck, id);
    this._high = maximumPosition(this._high, id);
    const acknowledged: PulsarMessageId[] = [];

    for (const entry of this._entries.values()) {
      const comparison = compareEntry(entry, id);
      if (comparison < 0) {
        for (const index of this._entryIndexes(entry)) {
          const child = this._ensureChild(entry, index);
          if (child.status !== "acked") {
            child.status = "acked";
            acknowledged.push(
              makePosition(entry.ledgerId, entry.entryId, index, entry.partitionIndex),
            );
          }
        }
        entry.sealed = true;
        continue;
      }
      if (comparison > 0) {
        continue;
      }

      if (id.batchIndex < 0) {
        for (const index of this._entryIndexes(entry)) {
          const child = this._ensureChild(entry, index);
          if (child.status !== "acked") {
            child.status = "acked";
            acknowledged.push(
              makePosition(entry.ledgerId, entry.entryId, index, entry.partitionIndex),
            );
          }
        }
        entry.sealed = true;
      } else {
        const indexes = this._entryIndexes(entry);
        if (indexes.length === 0) {
          indexes.push(0);
        }
        for (const index of indexes) {
          if (index < 0 || index > id.batchIndex) {
            continue;
          }
          const child = this._ensureChild(entry, index);
          if (child.status !== "acked") {
            child.status = "acked";
            acknowledged.push(
              makePosition(entry.ledgerId, entry.entryId, index, entry.partitionIndex),
            );
          }
        }
      }
      this._raiseHigh(entry);
    }

    let directCommit: PulsarMessageId | null = null;
    if (id.batchIndex < 0) {
      directCommit = id;
    } else {
      const entry = this._entries.get(entryKey(id));
      if (entry !== undefined && this._entryFullyDone(entry)) {
        directCommit = this._entryEnd(entry);
      }
    }

    if (
      directCommit !== null &&
      (this._cursor === null || comparePositions(directCommit, this._cursor) > 0)
    ) {
      this._cursor = clonePosition(directCommit);
    }
    this._advance();
    this._persistIfChanged(previousCursor);

    return this._buildUpdate({
      changed:
        acknowledged.length > 0 ||
        comparePositions(previousCursor, this._cursor) !== 0,
      advanced: comparePositions(previousCursor, this._cursor) < 0,
      duplicate,
      acknowledged,
    });
  }

  private _negativeAcknowledge(
    id: PulsarMessageId,
    options?: AckOptions,
  ): CursorUpdate {
    const stale = this._checkToken(id, options);
    if (stale) {
      return this._buildUpdate({
        accepted: false,
        stale: true,
      });
    }

    if (
      this._truncation !== null &&
      comparePositions(id, this._truncation) <= 0
    ) {
      return this._buildUpdate({
        accepted: false,
        truncated: true,
      });
    }

    this._generation += 1;
    const normalized = normalizeInput(id);
    const optionBatchSize = typeof options?.batchSize === "number"
      ? options.batchSize
      : undefined;
    const entry = this._ensureEntry(id, normalized.batchSize ?? optionBatchSize);
    const previousCursor = this._cursor;
    const denied: PulsarMessageId[] = [];
    const indexes = entry.batch && id.batchIndex === -1
      ? this._entryIndexes(entry)
      : [id.batchIndex];

    for (const index of indexes) {
      const child = this._ensureChild(entry, index);
      child.status = "denied";
      child.attempts += 1;
      child.epoch += 1;
      child.token = this._makeToken(entry, child);
      denied.push(
        makePosition(entry.ledgerId, entry.entryId, index, entry.partitionIndex),
      );
    }
    entry.epoch += 1;

    if (
      this._cumulativeAck !== null &&
      comparePositions(id, this._cumulativeAck) <= 0
    ) {
      this._cumulativeAck = previousPosition(id);
    }

    if (this._cursor !== null && compareEntry(this._cursor, id) >= 0) {
      this._cursor = this._lastEntryEndBefore(id);
    }
    this._raiseHigh(entry);
    this._persistIfChanged(previousCursor);

    return this._buildUpdate({
      changed: true,
      advanced: false,
      acknowledged: [],
      denied,
    });
  }

  private _buildUpdate(
    values: Partial<CursorUpdate> & { acknowledged?: PulsarMessageId[] },
  ): CursorUpdate {
    return buildUpdate(
      clonePosition(this._cursor),
      this.getPendingInterval(),
      this._generation,
      values,
    );
  }

  private _ensureEntry(
    id: PulsarMessageId,
    batchSize?: number,
  ): EntryState {
    const key = entryKey(id);
    let entry = this._entries.get(key);
    const isBatch = id.batchIndex >= 0 || (batchSize !== undefined && batchSize > 1);
    if (entry === undefined) {
      entry = {
        ledgerId: id.ledgerId,
        entryId: id.entryId,
        ...(id.partitionIndex !== undefined
          ? { partitionIndex: id.partitionIndex }
          : {}),
        ...(batchSize !== undefined ? { batchSize } : {}),
        sealed: false,
        batch: isBatch,
        children: new Map(),
        minIndex: id.batchIndex,
        maxIndex: id.batchIndex,
        epoch: 0,
      };
      this._entries.set(key, entry);
      this._sealEarlierUnknownBatches(entry);
    } else {
      if (batchSize !== undefined) {
        if (entry.batchSize !== undefined && entry.batchSize !== batchSize) {
          throw new RangeError("batchSize conflicts with the registered batch");
        }
        entry.batchSize = batchSize;
        entry.batch = true;
      }
      if (isBatch) {
        entry.batch = true;
      }
    }

    if (
      entry.batchSize !== undefined &&
      id.batchIndex >= entry.batchSize &&
      id.batchIndex >= 0
    ) {
      throw new RangeError("batchIndex is outside the registered batch");
    }

    this._applyTruncation(entry);
    return entry;
  }

  private _ensureChild(entry: EntryState, batchIndex: number): ChildState {
    let child = entry.children.get(batchIndex);
    if (child === undefined) {
      child = {
        batchIndex,
        status: "pending",
        seen: false,
        attempts: 0,
        epoch: 0,
        token: "",
      };
      entry.children.set(batchIndex, child);
      entry.minIndex = entry.minIndex < 0
        ? batchIndex
        : Math.min(entry.minIndex, batchIndex);
      entry.maxIndex = Math.max(entry.maxIndex, batchIndex);
    }
    child.seen = true;
    child.token = this._makeToken(entry, child);

    const position = makePosition(
      entry.ledgerId,
      entry.entryId,
      batchIndex,
      entry.partitionIndex,
    );
    if (
      this._truncation !== null &&
      comparePositions(position, this._truncation) <= 0
    ) {
      child.status = "truncated";
    } else if (
      this._cumulativeAck !== null &&
      comparePositions(position, this._cumulativeAck) <= 0 &&
      child.status === "pending"
    ) {
      child.status = "acked";
    }
    return child;
  }

  private _entryIndexes(entry: EntryState): number[] {
    if (!entry.batch) {
      return entry.children.size === 0 ? [-1] : Array.from(entry.children.keys());
    }
    if (entry.batchSize !== undefined) {
      return Array.from({ length: entry.batchSize }, (_, index) => index);
    }
    const indexes = Array.from(entry.children.keys()).filter((index) => index >= 0);
    indexes.sort((left, right) => left - right);
    return indexes;
  }

  private _entryEnd(entry: EntryState): PulsarMessageId {
    let index = -1;
    if (entry.batch) {
      if (entry.batchSize !== undefined) {
        index = entry.batchSize - 1;
      } else {
        index = Math.max(entry.maxIndex, 0);
      }
    }
    return makePosition(
      entry.ledgerId,
      entry.entryId,
      index,
      entry.partitionIndex,
      entry.batchSize,
    );
  }

  private _entryStart(entry: EntryState): PulsarMessageId {
    return makePosition(
      entry.ledgerId,
      entry.entryId,
      entry.batch ? 0 : -1,
      entry.partitionIndex,
    );
  }

  private _entryFullyDone(entry: EntryState): boolean {
    this._applyTruncation(entry);

    if (entry.batchSize !== undefined) {
      for (let index = 0; index < entry.batchSize; index += 1) {
        if (!this._childTerminal(entry, index)) {
          return false;
        }
      }
      return true;
    }

    if (!entry.batch) {
      return this._childTerminal(entry, -1);
    }

    const indexes = Array.from(entry.children.keys())
      .filter((index) => index >= 0)
      .sort((left, right) => left - right);
    if (indexes.length === 0) {
      return false;
    }

    if (!entry.sealed && !this._inferBatchSize) {
      return false;
    }

    const maximum = indexes[indexes.length - 1];
    for (let index = 0; index <= maximum; index += 1) {
      if (!this._childTerminal(entry, index)) {
        return false;
      }
    }
    return true;
  }

  private _childTerminal(entry: EntryState, batchIndex: number): boolean {
    const child = entry.children.get(batchIndex);
    if (child !== undefined) {
      if (child.status === "acked" || child.status === "truncated") {
        return true;
      }
      if (child.status === "denied") {
        return false;
      }
    }

    const id = makePosition(
      entry.ledgerId,
      entry.entryId,
      batchIndex,
      entry.partitionIndex,
    );
    if (this._truncation !== null && comparePositions(id, this._truncation) <= 0) {
      return true;
    }
    if (this._cumulativeAck !== null && comparePositions(id, this._cumulativeAck) <= 0) {
      return true;
    }
    return this._cursor !== null && comparePositions(id, this._cursor) <= 0;
  }

  private _applyTruncation(entry: EntryState): void {
    if (this._truncation === null) {
      return;
    }
    if (
      this._truncation.batchIndex < 0 &&
      compareEntry(entry, this._truncation) <= 0
    ) {
      for (const index of this._entryIndexes(entry)) {
        const child = this._ensureChild(entry, index);
        child.status = "truncated";
      }
      entry.sealed = true;
      return;
    }
    const end = this._entryEnd(entry);
    if (comparePositions(end, this._truncation) <= 0) {
      for (const index of this._entryIndexes(entry)) {
        const child = this._ensureChild(entry, index);
        child.status = "truncated";
      }
      entry.sealed = true;
      return;
    }
    if (compareEntry(entry, this._truncation) === 0 && this._truncation.batchIndex >= 0) {
      for (const child of entry.children.values()) {
        if (
          child.batchIndex >= 0 &&
          child.batchIndex <= this._truncation.batchIndex &&
          child.status !== "acked"
        ) {
          child.status = "truncated";
        }
      }
    }
  }

  private _advance(): boolean {
    const previous = this._cursor;
    let cursor = this._cursor;
    const sorted = this._sortedEntries();

    for (const entry of sorted) {
      const end = this._entryEnd(entry);
      if (cursor !== null && comparePositions(end, cursor) <= 0) {
        continue;
      }

      if (cursor !== null && compareEntry(entry, cursor) === 0) {
        if (!this._entryFullyDone(entry)) {
          break;
        }
        cursor = end;
        continue;
      }

      if (cursor === null) {
        if (!this._entryFullyDone(entry)) {
          break;
        }
        cursor = end;
        continue;
      }

      const next = this._nextLogicalPosition(cursor);
      if (next === null) {
        break;
      }

      const start = this._entryStart(entry);
      if (compareEntry(start, next) > 0) {
        break;
      }
      if (compareEntry(start, next) < 0) {
        break;
      }

      if (!this._entryFullyDone(entry)) {
        break;
      }
      cursor = end;
    }

    if (cursor !== null && comparePositions(previous, cursor) < 0) {
      this._cursor = clonePosition(cursor);
      return true;
    }
    return false;
  }

  private _nextLogicalPosition(id: PulsarMessageId): PulsarMessageId | null {
    if (id.batchIndex >= 0) {
      const entry = this._entries.get(entryKey(id));
      if (entry !== undefined) {
        if (entry.batchSize !== undefined) {
          if (id.batchIndex + 1 < entry.batchSize) {
            return makePosition(
              id.ledgerId,
              id.entryId,
              id.batchIndex + 1,
              id.partitionIndex,
            );
          }
        } else {
          const nextIndex = Array.from(entry.children.keys())
            .filter((index) => index > id.batchIndex)
            .sort((left, right) => left - right)[0];
          if (nextIndex !== undefined) {
            return makePosition(
              id.ledgerId,
              id.entryId,
              nextIndex,
              id.partitionIndex,
            );
          }
        }
      }
    }
    return makePosition(
      id.ledgerId,
      id.entryId + 1n,
      -1,
      id.partitionIndex,
    );
  }

  private _lastEntryEndBefore(id: PulsarMessageId): PulsarMessageId | null {
    let result: PulsarMessageId | null = this._truncation !== null &&
      comparePositions(this._truncation, id) < 0
      ? this._truncation
      : null;

    if (this._cumulativeAck !== null) {
      const cumulative = this._cumulativeAck;
      const safe =
        comparePositions(cumulative, id) < 0 &&
        (cumulative.batchIndex < 0 ||
          compareEntry(cumulative, id) < 0);
      if (safe) {
        result = maximumPosition(result, cumulative);
      }
    }

    for (const entry of this._sortedEntries()) {
      if (compareEntry(entry, id) >= 0) {
        break;
      }
      if (!this._entryFullyDone(entry)) {
        continue;
      }
      const end = this._entryEnd(entry);
      if (comparePositions(end, id) < 0) {
        result = maximumPosition(result, end);
      }
    }
    return result;
  }

  private _pendingBase(): PulsarMessageId | null {
    if (this._cursor === null) {
      const sorted = this._sortedEntries();
      if (sorted.length === 0) {
        if (this._high === null) {
          return null;
        }
        if (this._high.batchIndex >= 0) {
          return makePosition(
            this._high.ledgerId,
            this._high.entryId,
            this._high.batchIndex + 1,
            this._high.partitionIndex,
          );
        }
        return makePosition(
          this._high.ledgerId,
          this._high.entryId + 1n,
          -1,
          this._high.partitionIndex,
        );
      }
      return this._entryStart(sorted[0]);
    }

    const next = this._nextLogicalPosition(this._cursor);
    if (next === null) {
      return null;
    }

    for (const entry of this._sortedEntries()) {
      if (compareEntry(entry, this._cursor) <= 0) {
        continue;
      }
      const start = this._entryStart(entry);
      if (compareEntry(start, next) === 0) {
        if (
          this._cursor.batchIndex >= 0 &&
          compareEntry(this._cursor, entry) === 0
        ) {
          return next;
        }
        return start;
      }
      if (compareEntry(start, next) > 0) {
        return next;
      }
    }
    return next;
  }

  private _collectUnresolved(): PulsarMessageId[] {
    const result: PulsarMessageId[] = [];
    for (const entry of this._sortedEntries()) {
      const indexes = this._entryIndexes(entry);
      for (const index of indexes) {
        if (this._childTerminal(entry, index)) {
          continue;
        }
        const id = makePosition(
          entry.ledgerId,
          entry.entryId,
          index,
          entry.partitionIndex,
        );
        if (
          this._cursor !== null &&
          comparePositions(id, this._cursor) <= 0
        ) {
          continue;
        }
        if (
          this._truncation !== null &&
          comparePositions(id, this._truncation) <= 0
        ) {
          continue;
        }
        result.push(id);
      }
    }
    result.sort(comparePositions);
    return result;
  }

  private _effectiveHigh(): PulsarMessageId | null {
    let result = this._high;
    for (const entry of this._entries.values()) {
      const end = this._entryEnd(entry);
      result = maximumPosition(result, end);
    }
    if (
      this._cursor !== null &&
      result !== null &&
      comparePositions(result, this._cursor) <= 0
    ) {
      return null;
    }
    return result;
  }

  private _raiseHigh(entry: EntryState): void {
    this._high = maximumPosition(this._high, this._entryEnd(entry));
  }

  private _sortedEntries(): EntryState[] {
    return Array.from(this._entries.values()).sort((left, right) => {
      const ledger = compareBigInt(left.ledgerId, right.ledgerId);
      if (ledger !== 0) {
        return ledger;
      }
      const entry = compareBigInt(left.entryId, right.entryId);
      if (entry !== 0) {
        return entry;
      }
      return (left.partitionIndex ?? 0) - (right.partitionIndex ?? 0);
    });
  }

  private _sealEarlierUnknownBatches(newEntry: EntryState): void {
    for (const entry of this._entries.values()) {
      if (entry === newEntry) {
        continue;
      }
      if (!entry.batch || entry.batchSize !== undefined || entry.sealed) {
        continue;
      }
      if (compareEntry(entry, newEntry) < 0) {
        entry.sealed = true;
      }
    }
  }

  private _makeToken(entry: EntryState, child: ChildState): string {
    return [
      entry.partitionIndex ?? "",
      entry.ledgerId.toString(),
      entry.entryId.toString(),
      child.batchIndex,
      child.epoch,
    ].join(":");
  }

  private _checkToken(id: PulsarMessageId, options?: AckOptions): boolean {
    if (options === undefined) {
      return false;
    }
    const token = options.token ?? options.deliveryToken ?? options.ackToken;
    if (token === undefined) {
      return options.generation !== undefined &&
        options.generation !== this._generation;
    }
    const entry = this._entries.get(entryKey(id));
    if (entry === undefined) {
      return true;
    }
    if (entry.batch && id.batchIndex === -1) {
      return !Array.from(entry.children.values()).some(
        (child) => child.token === token,
      );
    }
    const child = entry.children.get(id.batchIndex);
    if (child === undefined) {
      return true;
    }
    return child.token !== token;
  }

  private _persistIfChanged(previous: PulsarMessageId | null): void {
    if (comparePositions(previous, this._cursor) === 0) {
      return;
    }
    this.persistNow();
  }

  private _areAdjacent(left: PulsarMessageId, right: PulsarMessageId): boolean {
    const next = this._nextLogicalPosition(left);
    return next !== null && comparePositions(next, right) === 0;
  }

  private _positionsBetween(
    start: PulsarMessageId,
    end: PulsarMessageId,
  ): PulsarMessageId[] {
    return this._collectUnresolved().filter(
      (position) =>
        comparePositions(position, start) >= 0 &&
        comparePositions(position, end) <= 0,
    );
  }
}

export const Cursor = PulsarCursor;
export const MessageCursor = PulsarCursor;
export const TopicCursor = PulsarCursor;
export const PulsarMessageCursor = PulsarCursor;
export const PulsarCursorManager = PulsarCursor;
export const PendingCursor = PulsarCursor;
export const PulsarConsumerCursor = PulsarCursor;
export const ConsumerCursor = PulsarCursor;
export type PulsarCursorState = CursorSnapshot;

export function createCursor(
  options?: PulsarCursorOptions | IdLike | null,
  entryId?: NumericId,
  batchIndex?: number,
): PulsarCursor {
  return new PulsarCursor(options, entryId, batchIndex);
}

export const createPulsarCursor = createCursor;

export function createPulsarMessageId(
  ledgerId: NumericId,
  entryId: NumericId,
  batchIndex?: number,
  partitionIndex?: number,
  batchSize?: number,
): PulsarMessageId {
  return makePosition(
    parseInteger(ledgerId, "ledgerId"),
    parseInteger(entryId, "entryId"),
    normalizeBatchIndex(batchIndex),
    partitionIndex,
    batchSize,
  );
}

export const messageId = createPulsarMessageId;
export const msgId = createPulsarMessageId;
export const createMessageId = createPulsarMessageId;
export const makeMessageId = createPulsarMessageId;

export function normalizeMessageId(
  input: IdLike | MessageIdInput,
  entryId?: NumericId,
  batchIndex?: number,
): PulsarMessageId {
  return normalizeInput(input, entryId, batchIndex).id;
}

export function compareMessageIds(
  left: IdLike | MessageIdInput,
  right: IdLike | MessageIdInput,
): -1 | 0 | 1 {
  const result = comparePositions(normalizeInput(left).id, normalizeInput(right).id);
  return result < 0 ? -1 : result > 0 ? 1 : 0;
}

export const comparePositionsById = compareMessageIds;
export const compareMessageId = compareMessageIds;
export { comparePositions, compareEntry, entryKey, positionKey };

export function isBatchMessageId(input: IdLike | MessageIdInput): boolean {
  return isBatchPosition(normalizeInput(input).id);
}

export const isBatch = isBatchMessageId;

export function nextMessageId(
  input: IdLike | MessageIdInput,
  batchSize?: number,
): PulsarMessageId {
  const id = normalizeInput(input).id;
  if (
    id.batchIndex >= 0 &&
    batchSize !== undefined &&
    id.batchIndex + 1 < batchSize
  ) {
    return makePosition(
      id.ledgerId,
      id.entryId,
      id.batchIndex + 1,
      id.partitionIndex,
    );
  }
  return makePosition(id.ledgerId, id.entryId + 1n, -1, id.partitionIndex);
}

export function previousMessageId(
  input: IdLike | MessageIdInput,
): PulsarMessageId | null {
  return previousPosition(normalizeInput(input).id);
}

export function formatMessageId(input: IdLike | MessageIdInput): string {
  const id = normalizeInput(input).id;
  const partition = id.partitionIndex === undefined ? "" : `${id.partitionIndex}:`;
  return `${partition}${id.ledgerId.toString()}:${id.entryId.toString()}:${id.batchIndex}`;
}

export function acknowledge(
  cursor: PulsarCursor,
  input: IdLike | MessageIdInput,
  options?: AckOptions,
): CursorUpdate {
  return cursor.acknowledge(input, options);
}

export function acknowledgeCumulative(
  cursor: PulsarCursor,
  input: IdLike | MessageIdInput,
  options?: AckOptions,
): CursorUpdate {
  return cursor.acknowledgeCumulative(input, options);
}

export const ack = acknowledge;
export const ackCumulative = acknowledgeCumulative;

export function negativeAcknowledge(
  cursor: PulsarCursor,
  input: IdLike | MessageIdInput,
  options?: AckOptions,
): CursorUpdate {
  return cursor.negativeAcknowledge(input, options);
}

export const nack = negativeAcknowledge;
export const deny = negativeAcknowledge;

export function truncateTopic(
  cursor: PulsarCursor,
  input: IdLike | MessageIdInput,
  options?: { inclusive?: boolean },
): CursorUpdate {
  return cursor.truncate(input, options);
}

export const truncate = truncateTopic;

export function pendingInterval(
  cursor: PulsarCursor,
): PendingInterval | null {
  return cursor.getPendingInterval();
}

export const pendingRange = pendingInterval;

export function getPendingRange(
  cursor: PulsarCursor,
): PendingInterval | null {
  return cursor.getPendingInterval();
}

export function getPending(
  cursor: PulsarCursor,
): PendingInterval | null {
  return cursor.getPendingInterval();
}

export function snapshot(cursor: PulsarCursor): CursorSnapshot {
  return cursor.snapshot();
}

export function serializeCursor(cursor: PulsarCursor): string {
  return cursor.serialize();
}

export function deserializeCursor(
  value: CursorSnapshot | Record<string, unknown> | string,
  options?: Omit<
    PulsarCursorOptions,
    "initialPosition" | "initialCursor" | "cursor" | "committed"
  >,
): PulsarCursor {
  return PulsarCursor.deserialize(value, options);
}

export default PulsarCursor;
