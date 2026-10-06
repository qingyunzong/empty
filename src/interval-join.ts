/**
 * Streaming interval join over two streams of half-open time intervals.
 *
 * Semantics
 * ---------
 * - Every event carries a half-open interval [start, end); two events join
 *   when their intervals overlap. The emitted result is the non-empty
 *   intersection together with both source ids.
 * - A single logical watermark is shared by both sides. Watermark W is a
 *   promise that no future event will have start < W.
 * - Reclamation: when the watermark advances to W, every resident item with
 *   end <= W can never match a future event (any future interval starts at
 *   >= W >= item.end, and half-open intervals that merely touch do not
 *   overlap), so it is dropped.
 * - Lateness: an arriving event with start < current watermark is rejected.
 * - Backpressure: the number of resident items is capped by `maxBuffered`;
 *   pushes arriving while the buffer is full are rejected with status
 *   "backpressure" and must be retried by the caller (typically after the
 *   watermark advances and reclaims space).
 */

export interface IntervalEvent {
  readonly id: string;
  /** Inclusive interval start. */
  readonly start: number;
  /** Exclusive interval end; must be > start. */
  readonly end: number;
}

export interface JoinResult {
  readonly leftId: string;
  readonly rightId: string;
  /** Inclusive start of the non-empty intersection. */
  readonly start: number;
  /** Exclusive end of the non-empty intersection. */
  readonly end: number;
}

export type PushStatus =
  | "ok" // accepted; `emitted` holds the new join results
  | "late" // event.start < current watermark -> rejected
  | "invalid" // malformed interval or duplicate resident id -> rejected
  | "backpressure"; // resident-item limit reached -> rejected, retry later

export interface PushOutcome {
  readonly status: PushStatus;
  readonly emitted: readonly JoinResult[];
}

export interface IntervalJoinOptions {
  /** Maximum number of resident (buffered) items across both sides. */
  readonly maxBuffered?: number;
}

type Side = "left" | "right";

export class IntervalJoin {
  private readonly left = new Map<string, IntervalEvent>();
  private readonly right = new Map<string, IntervalEvent>();
  private readonly maxBuffered: number;
  private watermark = Number.NEGATIVE_INFINITY;
  private reclaimedTotal = 0;

  constructor(options: IntervalJoinOptions = {}) {
    const cap = options.maxBuffered ?? Number.POSITIVE_INFINITY;
    if (!(cap > 0)) {
      throw new RangeError("maxBuffered must be a positive number");
    }
    this.maxBuffered = cap;
  }

  /** Number of resident items currently held across both sides. */
  get bufferedCount(): number {
    return this.left.size + this.right.size;
  }

  get currentWatermark(): number {
    return this.watermark;
  }

  /** Total number of items reclaimed by watermark advances so far. */
  get reclaimedCount(): number {
    return this.reclaimedTotal;
  }

  pushLeft(event: IntervalEvent): PushOutcome {
    return this.push(event, "left");
  }

  pushRight(event: IntervalEvent): PushOutcome {
    return this.push(event, "right");
  }

  /**
   * Advances the watermark (monotonic; stale values are ignored) and reclaims
   * every resident item whose interval can no longer intersect any future
   * event. Returns the number of reclaimed items.
   */
  advanceWatermark(watermark: number): number {
    if (!Number.isFinite(watermark) || watermark <= this.watermark) {
      return 0;
    }
    this.watermark = watermark;
    let reclaimed = 0;
    reclaimed += reclaimBefore(this.left, watermark);
    reclaimed += reclaimBefore(this.right, watermark);
    this.reclaimedTotal += reclaimed;
    return reclaimed;
  }

  private push(event: IntervalEvent, side: Side): PushOutcome {
    if (!isValidEvent(event)) {
      return { status: "invalid", emitted: [] };
    }
    if (event.start < this.watermark) {
      return { status: "late", emitted: [] };
    }
    const own = side === "left" ? this.left : this.right;
    if (own.has(event.id)) {
      return { status: "invalid", emitted: [] };
    }
    if (this.bufferedCount >= this.maxBuffered) {
      return { status: "backpressure", emitted: [] };
    }
    const other = side === "left" ? this.right : this.left;
    const emitted: JoinResult[] = [];
    for (const candidate of other.values()) {
      const start = Math.max(event.start, candidate.start);
      const end = Math.min(event.end, candidate.end);
      if (start < end) {
        emitted.push(
          side === "left"
            ? { leftId: event.id, rightId: candidate.id, start, end }
            : { leftId: candidate.id, rightId: event.id, start, end },
        );
      }
    }
    own.set(event.id, event);
    return { status: "ok", emitted };
  }
}

function isValidEvent(event: IntervalEvent): boolean {
  return (
    typeof event.id === "string" &&
    event.id.length > 0 &&
    Number.isFinite(event.start) &&
    Number.isFinite(event.end) &&
    event.end > event.start
  );
}

function reclaimBefore(
  buffer: Map<string, IntervalEvent>,
  watermark: number,
): number {
  let reclaimed = 0;
  for (const [id, event] of buffer) {
    if (event.end <= watermark) {
      buffer.delete(id);
      reclaimed += 1;
    }
  }
  return reclaimed;
}

/**
 * Offline reference: full pairwise join of two event collections. Used to
 * verify the streaming operator against an exhaustive brute-force pairing.
 */
export function offlineJoin(
  leftEvents: readonly IntervalEvent[],
  rightEvents: readonly IntervalEvent[],
): JoinResult[] {
  const results: JoinResult[] = [];
  for (const left of leftEvents) {
    for (const right of rightEvents) {
      const start = Math.max(left.start, right.start);
      const end = Math.min(left.end, right.end);
      if (start < end) {
        results.push({ leftId: left.id, rightId: right.id, start, end });
      }
    }
  }
  return results;
}
