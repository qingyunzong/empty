/**
 * Streaming as-of join for time-series data.
 *
 * A left event is joined with the newest right version that:
 *   - has the same key,
 *   - is not later than the left event, and
 *   - is within `tolerance` of the left event.
 *
 * Right versions sharing a timestamp are ordered by `sourceSeq` (highest wins
 * by default). Rights may arrive out of order; they are held until the bounded
 * watermark says that no earlier event can still be on time. Once a left
 * result has been emitted it is immutable: a right event that arrives after
 * that point is late and cannot change the result already produced.
 */

export type AsOfKey = unknown;

export type TieBreak = "max-source-seq" | "min-source-seq" | "max" | "min";
export type LateRightPolicy = "drop" | "keep";

export interface AsOfJoinOptions<L = unknown, R = unknown, K = AsOfKey> {
  /** Maximum allowed age of a right version. Defaults to 0. */
  tolerance?: number;
  /** Alias for `tolerance`. */
  toleranceMs?: number;
  /**
   * Bounded disorder, in event-time units. The watermark is
   * `maxObservedEventTime - allowedLateness`. Defaults to 0.
   */
  allowedLateness?: number;
  /** Alias for `allowedLateness`. */
  maxOutOfOrderness?: number;
  /** Alias for `allowedLateness`. */
  maxLateness?: number;
  /** Alias for `allowedLateness`. */
  lateness?: number;
  /** Alias for `allowedLateness`. */
  watermarkDelay?: number;
  /** Extracts the join key. Defaults to `event.key`. */
  key?: (event: L | R) => K;
  /** Alias for `key`. */
  getKey?: (event: L | R) => K;
  /**
   * Extracts event time. Defaults to `time`, `timestamp`, `ts`,
   * `eventTime`, or `event_time`.
   */
  time?: (event: L | R) => number;
  /** Alias for `time`. */
  timestamp?: (event: L | R) => number;
  /** Alias for `time`. */
  getTime?: (event: L | R) => number;
  /**
   * Extracts the source sequence of a right event. Defaults to `sourceSeq`,
   * `sourceSequence`, `source_sequence`, `seq`, or `sequence`.
   */
  sourceSeq?: (event: R) => number;
  /** Alias for `sourceSeq`. */
  getSourceSeq?: (event: R) => number;
  /**
   * How to choose between right events at the same timestamp. The default is
   * `"max-source-seq"` (the newest source version wins).
   */
  tieBreak?: TieBreak;
  /**
   * What to do with a right event that arrives behind the watermark.
   * `"drop"` (the default) rejects it. `"keep"` retains it for future left
   * events, but never rewrites an already emitted result.
   */
  latePolicy?: LateRightPolicy;
  /** Called once for every emitted join result, in emission order. */
  onResult?: (result: JoinResult<L, R, K>) => void;
}

export interface JoinResult<L = unknown, R = unknown, K = AsOfKey> {
  /** The original left event. */
  left: L;
  /** The selected right version, or `null` when no version qualifies. */
  right: R | null;
  matched: boolean;
  key: K;
  leftTime: number;
  rightTime: number | null;
  /** Source sequence of the selected right version, or `null`. */
  rightSourceSeq: number | null;
}

export type AsOfJoinResult<L = unknown, R = unknown, K = AsOfKey> = JoinResult<
  L,
  R,
  K
>;

export interface LeftEvent<K = AsOfKey, V = unknown> {
  key: K;
  time: number;
  value?: V;
  sourceSeq?: number;
}

export interface RightEvent<K = AsOfKey, V = unknown> {
  key: K;
  time: number;
  sourceSeq?: number;
  value?: V;
}

export type StreamEvent<L = unknown, R = unknown> =
  | ({ type: "left"; side?: undefined } & L)
  | ({ type: "right"; side?: undefined } & R)
  | ({ type: "watermark"; time: number; side?: undefined } & Record<string, unknown>)
  | ({ side: "left"; type?: undefined } & L)
  | ({ side: "right"; type?: undefined } & R);

interface RightRecord<R> {
  event: R;
  time: number;
  seq: number;
}

interface LeftRecord<L, K> {
  event: L;
  key: K;
  time: number;
  order: number;
}

const NEGATIVE_INFINITY = Number.NEGATIVE_INFINITY;

function fieldOf(event: unknown, names: readonly string[]): unknown {
  if (event === null || typeof event !== "object") {
    return undefined;
  }
  for (const name of names) {
    const value = (event as Record<string, unknown>)[name];
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function toTimestamp(value: unknown, label: string): number {
  if (value === null || value === undefined || value === "") {
    throw new TypeError(`${label} must be a finite event time`);
  }
  const numeric = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(numeric)) {
    throw new TypeError(`${label} must be a finite event time`);
  }
  return numeric;
}

function toSequence(value: unknown, label: string): number {
  if (value === undefined || value === null) {
    return 0;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return numeric;
}

function defaultKey(event: unknown): unknown {
  const key = fieldOf(event, ["key"]);
  if (key === undefined) {
    throw new TypeError("event.key is required");
  }
  return key;
}

function defaultTime(event: unknown): number {
  const value = fieldOf(event, [
    "time",
    "timestamp",
    "ts",
    "eventTime",
    "event_time",
  ]);
  if (value === undefined) {
    throw new TypeError("event time is required (time/timestamp/ts)");
  }
  return toTimestamp(value, "event time");
}

function defaultSourceSeq(event: unknown): number {
  const value = fieldOf(event, [
    "sourceSeq",
    "sourceSequence",
    "source_sequence",
    "seq",
    "sequence",
  ]);
  return toSequence(value, "sourceSeq");
}

function compareRight(
  a: { time: number; seq: number },
  b: { time: number; seq: number },
): number {
  return a.time === b.time ? a.seq - b.seq : a.time - b.time;
}

/** Insert a right record into a time/source-sequence ordered array. */
function insertRightRecord<R>(
  records: RightRecord<R>[],
  record: RightRecord<R>,
): void {
  let low = 0;
  let high = records.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareRight(records[middle], record) <= 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  const previous = records[low - 1];
  if (
    previous !== undefined &&
    previous.time === record.time &&
    previous.seq === record.seq
  ) {
    // The same source version may be retried. Keep the newest payload before
    // closure; emitted results are never revisited.
    records[low - 1] = record;
    return;
  }
  records.splice(low, 0, record);
}

/**
 * Find the best right version for a left time.
 *
 * `records` is ordered by (time asc, sourceSeq asc). The last record not later
 * than the left time is the newest timestamp; for that timestamp the last
 * record is the highest source sequence (or the first for a `min` tie break).
 */
function findRightRecord<R>(
  records: RightRecord<R>[] | undefined,
  leftTime: number,
  tolerance: number,
  tieBreak: TieBreak,
): RightRecord<R> | null {
  if (records === undefined || records.length === 0) {
    return null;
  }

  let low = 0;
  let high = records.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (records[middle].time <= leftTime) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  if (low === 0) {
    return null;
  }

  const candidate = records[low - 1];
  if (leftTime - candidate.time > tolerance) {
    return null;
  }

  if (tieBreak === "min" || tieBreak === "min-source-seq") {
    let firstAtSameTime = low - 1;
    while (
      firstAtSameTime > 0 &&
      records[firstAtSameTime - 1].time === candidate.time
    ) {
      firstAtSameTime -= 1;
    }
    return records[firstAtSameTime];
  }
  return candidate;
}

function normalizeTieBreak(value: TieBreak | undefined): TieBreak {
  if (value === undefined) {
    return "max-source-seq";
  }
  if (
    value !== "max" &&
    value !== "min" &&
    value !== "max-source-seq" &&
    value !== "min-source-seq"
  ) {
    throw new RangeError(`unsupported tieBreak: ${String(value)}`);
  }
  return value;
}

function optionNumber(
  values: readonly (number | undefined)[],
  label: string,
  fallback: number,
): number {
  for (const value of values) {
    if (value !== undefined) {
      if (Number.isNaN(value) || value < 0) {
        throw new RangeError(`${label} must be a non-negative number`);
      }
      return value;
    }
  }
  return fallback;
}

function leftBefore<L, K>(a: LeftRecord<L, K>, b: LeftRecord<L, K>): boolean {
  return a.time === b.time ? a.order < b.order : a.time < b.time;
}

/** Min-heap of pending left events ordered by (event time, arrival order). */
class LeftHeap<L, K> {
  private items: LeftRecord<L, K>[] = [];

  get size(): number {
    return this.items.length;
  }

  peek(): LeftRecord<L, K> | undefined {
    return this.items[0];
  }

  push(record: LeftRecord<L, K>): void {
    const items = this.items;
    items.push(record);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (!leftBefore(record, items[parent])) {
        break;
      }
      items[index] = items[parent];
      index = parent;
    }
    items[index] = record;
  }

  pop(): LeftRecord<L, K> | undefined {
    const items = this.items;
    if (items.length === 0) {
      return undefined;
    }
    const first = items[0];
    const last = items.pop() as LeftRecord<L, K>;
    if (items.length === 0) {
      return first;
    }

    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= items.length) {
        break;
      }
      const right = left + 1;
      let child = left;
      if (right < items.length && leftBefore(items[right], items[left])) {
        child = right;
      }
      if (!leftBefore(items[child], last)) {
        break;
      }
      items[index] = items[child];
      index = child;
    }
    items[index] = last;
    return first;
  }

  drain(): LeftRecord<L, K>[] {
    const drained: LeftRecord<L, K>[] = [];
    let record = this.pop();
    while (record !== undefined) {
      drained.push(record);
      record = this.pop();
    }
    return drained;
  }
}

function buildResult<L, R, K>(
  left: LeftRecord<L, K>,
  right: RightRecord<R> | null,
): JoinResult<L, R, K> {
  return {
    left: left.event,
    right: right === null ? null : right.event,
    matched: right !== null,
    key: left.key,
    leftTime: left.time,
    rightTime: right === null ? null : right.time,
    rightSourceSeq: right === null ? null : right.seq,
  };
}

/**
 * Stateful as-of join.
 *
 * Left results are emitted when the watermark passes their event time. At that
 * point every right version that could legally match them has either arrived
 * or is late, so the result can be closed. Right events behind the watermark
 * are dropped by default and can never alter results that were already
 * emitted.
 */
export class AsOfJoin<L = unknown, R = unknown, K = AsOfKey> {
  private readonly keyOf: (event: L | R) => K;
  private readonly timeOf: (event: L | R) => number;
  private readonly sourceSeqOf: (event: R) => number;
  private readonly tolerance: number;
  private readonly allowedLateness: number;
  private readonly tieBreak: TieBreak;
  private readonly latePolicy: LateRightPolicy;
  private readonly onResult:
    | ((result: JoinResult<L, R, K>) => void)
    | undefined;

  private readonly rights = new Map<K, RightRecord<R>[]>();
  private readonly pending = new LeftHeap<L, K>();
  private readonly emitted: JoinResult<L, R, K>[] = [];

  private maxObservedTime = NEGATIVE_INFINITY;
  private currentWatermark = NEGATIVE_INFINITY;
  private nextOrder = 0;
  private isClosed = false;

  private lateRightCountValue = 0;
  private droppedRightCountValue = 0;
  private acceptedRightCountValue = 0;

  constructor(options: AsOfJoinOptions<L, R, K> | number = {}) {
    const config: AsOfJoinOptions<L, R, K> =
      typeof options === "number" ? { tolerance: options } : options;
    const tieBreak = normalizeTieBreak(config.tieBreak);
    const latePolicy = config.latePolicy ?? "drop";
    if (latePolicy !== "drop" && latePolicy !== "keep") {
      throw new RangeError(`unsupported latePolicy: ${String(latePolicy)}`);
    }

    this.keyOf =
      config.key ??
      config.getKey ??
      ((event: L | R): K => defaultKey(event) as K);
    this.timeOf =
      config.time ??
      config.timestamp ??
      config.getTime ??
      ((event: L | R): number => defaultTime(event));
    this.sourceSeqOf =
      config.sourceSeq ??
      config.getSourceSeq ??
      ((event: R): number => defaultSourceSeq(event));
    this.tolerance = optionNumber(
      [config.tolerance, config.toleranceMs],
      "tolerance",
      0,
    );
    this.allowedLateness = optionNumber(
      [
        config.allowedLateness,
        config.maxOutOfOrderness,
        config.maxLateness,
        config.lateness,
        config.watermarkDelay,
      ],
      "allowedLateness",
      0,
    );
    this.tieBreak = tieBreak;
    this.latePolicy = latePolicy;
    this.onResult = config.onResult;
  }

  /** Current watermark (event time minus bounded disorder). */
  get watermark(): number {
    return this.currentWatermark;
  }

  /** Largest event time observed on either input. */
  get maxEventTime(): number {
    return this.maxObservedTime;
  }

  /** Number of results emitted so far. */
  get resultCount(): number {
    return this.emitted.length;
  }

  /** Results emitted so far, in emission order. */
  get results(): readonly JoinResult<L, R, K>[] {
    return this.emitted;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get lateRightCount(): number {
    return this.lateRightCountValue;
  }

  get droppedRightCount(): number {
    return this.droppedRightCountValue;
  }

  get acceptedRightCount(): number {
    return this.acceptedRightCountValue;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /**
   * Add a right version.
   *
   * Returns any left results that became final because this event advanced the
   * watermark. A right version behind the watermark is counted as late and,
   * with the default policy, dropped without touching earlier results.
   */
  addRight(event: R): JoinResult<L, R, K>[] {
    if (this.isClosed) {
      this.droppedRightCountValue += 1;
      return [];
    }

    const record: RightRecord<R> = {
      event,
      time: toTimestamp(this.timeOf(event), "right event time"),
      seq: toSequence(this.sourceSeqOf(event), "right sourceSeq"),
    };

    if (record.time < this.currentWatermark) {
      this.lateRightCountValue += 1;
      if (this.latePolicy === "drop") {
        this.droppedRightCountValue += 1;
        return [];
      }
    }

    this.insertRight(record);
    this.acceptedRightCountValue += 1;
    this.observe(record.time);

    const results = this.drainClosed();
    this.purgeRights();
    return results;
  }

  /** Alias for {@link addRight}. */
  pushRight(event: R): JoinResult<L, R, K>[] {
    return this.addRight(event);
  }

  /** Alias for {@link addRight}. */
  ingestRight(event: R): JoinResult<L, R, K>[] {
    return this.addRight(event);
  }

  /**
   * Add a left event.
   *
   * Returns any left results that became final, including this event if it
   * arrived behind the watermark.
   */
  addLeft(event: L): JoinResult<L, R, K>[] {
    if (this.isClosed) {
      return [];
    }

    const record: LeftRecord<L, K> = {
      event,
      key: this.keyOf(event),
      time: toTimestamp(this.timeOf(event), "left event time"),
      order: this.nextOrder,
    };
    this.nextOrder += 1;

    this.pending.push(record);
    this.observe(record.time);

    const results = this.drainClosed();
    this.purgeRights();
    return results;
  }

  /** Alias for {@link addLeft}. */
  pushLeft(event: L): JoinResult<L, R, K>[] {
    return this.addLeft(event);
  }

  /** Alias for {@link addLeft}. */
  ingestLeft(event: L): JoinResult<L, R, K>[] {
    return this.addLeft(event);
  }

  /**
   * Feed a tagged stream event.
   *
   * `{ type: "left" }` and `{ type: "right" }` events are routed to the
   * corresponding input; `{ type: "watermark", time }` advances the watermark.
   * `side` is accepted as an alias for `type`.
   */
  push(event: StreamEvent<L, R>): JoinResult<L, R, K>[] {
    const tagged = event as Record<string, unknown>;
    const kind = tagged.type ?? tagged.side;
    if (kind === "left") {
      return this.addLeft(event as L);
    }
    if (kind === "right") {
      return this.addRight(event as R);
    }
    if (kind === "watermark") {
      return this.advanceWatermark(tagged.time as number);
    }
    const payload = tagged.event;
    if (payload !== undefined) {
      const nestedKind = (payload as Record<string, unknown>).type;
      if (nestedKind === "left") {
        return this.addLeft(payload as L);
      }
      if (nestedKind === "right") {
        return this.addRight(payload as R);
      }
    }
    throw new TypeError(
      'stream event must have type "left", "right", or "watermark"',
    );
  }

  /**
   * Advance the watermark to an absolute event-time watermark.
   *
   * Advancing may close pending left events and returns the newly emitted
   * results.
   */
  advanceWatermark(watermark: number): JoinResult<L, R, K>[] {
    const value =
      watermark === Number.POSITIVE_INFINITY
        ? watermark
        : toTimestamp(watermark, "watermark");
    if (value > this.currentWatermark) {
      this.currentWatermark = value;
      const frontier = Number.isFinite(this.allowedLateness)
        ? value + this.allowedLateness
        : value;
      if (frontier > this.maxObservedTime) {
        this.maxObservedTime = frontier;
      }
    }

    const results = this.drainClosed();
    this.purgeRights();
    return results;
  }

  /** Alias for {@link advanceWatermark}. */
  setWatermark(watermark: number): JoinResult<L, R, K>[] {
    return this.advanceWatermark(watermark);
  }

  /** Advance the watermark using an observed event time. */
  advanceToEventTime(eventTime: number): JoinResult<L, R, K>[] {
    const time = toTimestamp(eventTime, "event time");
    if (!Number.isFinite(this.allowedLateness)) {
      throw new RangeError(
        "cannot infer a watermark when allowedLateness is infinite",
      );
    }
    return this.advanceWatermark(time - this.allowedLateness);
  }

  /**
   * Return the best right version currently known for a left event without
   * buffering the left or emitting a result. Useful for probing or for batch
   * callers that have already sorted their input.
   */
  match(event: L): JoinResult<L, R, K> {
    const record: LeftRecord<L, K> = {
      event,
      key: this.keyOf(event),
      time: toTimestamp(this.timeOf(event), "left event time"),
      order: this.nextOrder,
    };
    const right = findRightRecord(
      this.rights.get(record.key),
      record.time,
      this.tolerance,
      this.tieBreak,
    );
    return buildResult(record, right);
  }

  /** Alias for {@link match}. */
  joinNow(event: L): JoinResult<L, R, K> {
    return this.match(event);
  }

  /** Alias for {@link match}. */
  join(event: L): JoinResult<L, R, K> {
    return this.match(event);
  }

  /**
   * Finalize every pending left event without waiting for a watermark.
   * Intended for end-of-input processing.
   */
  flush(): JoinResult<L, R, K>[] {
    const records = this.pending.drain();
    return records.map((record) => this.finalize(record));
  }

  /**
   * Flush pending left events and reject all future input. Results already in
   * `results` are never modified.
   */
  close(): JoinResult<L, R, K>[] {
    if (this.isClosed) {
      return [];
    }
    const results = this.flush();
    this.isClosed = true;
    this.currentWatermark = Number.POSITIVE_INFINITY;
    return results;
  }

  /** Alias for {@link close}. */
  end(): JoinResult<L, R, K>[] {
    return this.close();
  }

  /** Snapshot of emitted results. */
  getResults(): readonly JoinResult<L, R, K>[] {
    return this.emitted.slice();
  }

  private observe(time: number): void {
    if (time <= this.maxObservedTime) {
      return;
    }
    this.maxObservedTime = time;
    if (!Number.isFinite(this.allowedLateness)) {
      return;
    }
    const watermark = time - this.allowedLateness;
    if (watermark > this.currentWatermark) {
      this.currentWatermark = watermark;
    }
  }

  private insertRight(record: RightRecord<R>): void {
    const key = this.keyOf(record.event);
    let records = this.rights.get(key);
    if (records === undefined) {
      records = [];
      this.rights.set(key, records);
    }
    insertRightRecord(records, record);
  }

  private drainClosed(): JoinResult<L, R, K>[] {
    const results: JoinResult<L, R, K>[] = [];
    for (;;) {
      const record = this.pending.peek();
      if (record === undefined || record.time >= this.currentWatermark) {
        break;
      }
      this.pending.pop();
      results.push(this.finalize(record));
    }
    return results;
  }

  private finalize(record: LeftRecord<L, K>): JoinResult<L, R, K> {
    const right = findRightRecord(
      this.rights.get(record.key),
      record.time,
      this.tolerance,
      this.tieBreak,
    );
    const result = buildResult(record, right);
    this.emitted.push(result);
    if (this.onResult !== undefined) {
      this.onResult(result);
    }
    return result;
  }

  private purgeRights(): void {
    if (!Number.isFinite(this.currentWatermark)) {
      return;
    }
    const minimum = this.currentWatermark - this.tolerance;
    if (!Number.isFinite(minimum)) {
      return;
    }

    for (const [key, records] of this.rights) {
      let low = 0;
      let high = records.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (records[middle].time < minimum) {
          low = middle + 1;
        } else {
          high = middle;
        }
      }
      if (low > 0) {
        records.splice(0, low);
      }
      if (records.length === 0) {
        this.rights.delete(key);
      }
    }
  }
}

/**
 * Batch as-of join.
 *
 * Rights are indexed by key in (time, sourceSeq) order, so input order does not
 * matter. Results are returned in left-input order. This is the convenient
 * entry point for callers that already have complete data sets; use
 * {@link AsOfJoin} for watermark-driven streaming.
 */
export function asOfJoin<L = unknown, R = unknown, K = AsOfKey>(
  lefts: Iterable<L>,
  rights: Iterable<R>,
  options: AsOfJoinOptions<L, R, K> | number = {},
): JoinResult<L, R, K>[] {
  const config: AsOfJoinOptions<L, R, K> =
    typeof options === "number" ? { tolerance: options } : options;
  // A batch has no future input, so keep every right version addressable
  // instead of letting a watermark purge history.
  const join = new AsOfJoin<L, R, K>({
    ...config,
    allowedLateness: Number.POSITIVE_INFINITY,
  });
  for (const right of rights) {
    join.addRight(right);
  }

  const results: JoinResult<L, R, K>[] = [];
  for (const left of lefts) {
    const result = join.match(left);
    results.push(result);
    if (config.onResult !== undefined) {
      config.onResult(result);
    }
  }
  return results;
}

/** Create a stateful {@link AsOfJoin}. */
export function createAsOfJoin<L = unknown, R = unknown, K = AsOfKey>(
  options: AsOfJoinOptions<L, R, K> | number = {},
): AsOfJoin<L, R, K> {
  return new AsOfJoin<L, R, K>(options);
}

/** Alias for {@link createAsOfJoin}. */
export const createAsOfJoiner = createAsOfJoin;

/** Alias for {@link asOfJoin}. */
export const joinAsOf: typeof asOfJoin = asOfJoin;

/** Alias for {@link asOfJoin}. */
export const asOfJoinBatch: typeof asOfJoin = asOfJoin;

/** Lower-case alias for {@link asOfJoin}. */
export const asofJoin: typeof asOfJoin = asOfJoin;

/** All-lower-case alias for {@link asOfJoin}. */
export const asofjoin: typeof asOfJoin = asOfJoin;

export { AsOfJoin as AsOfJoiner, AsOfJoin as AsOfJoinEngine };

export default AsOfJoin;
