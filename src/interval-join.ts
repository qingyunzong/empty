/**
 * Streaming equi-join over two streams of half-open time intervals [start, end).
 *
 * Semantics:
 * - Every pair (left, right) with a non-empty intersection produces exactly one
 *   JoinMatch carrying both source ids and the intersection bounds.
 * - Each side has a monotone watermark. An event arriving on side S with
 *   `start < watermark[S]` is late and rejected.
 * - State is reclaimed only by watermarks: when side S's watermark advances to
 *   W, buffered items on the *opposite* side with `end <= W` are evicted,
 *   because any future event on S must have `start >= W` and therefore cannot
 *   overlap them. This is the exact safety condition, so no match is ever lost.
 * - Each side's buffer is bounded. A push into a full buffer is rejected with
 *   status "full" (the event is NOT consumed; the caller must retry later,
 *   e.g. after advancing the watermark, or use `pushAsync` to wait).
 */

export type Side = "left" | "right";

export interface IntervalEvent {
  readonly id: string;
  /** Inclusive start of the half-open interval. */
  readonly start: number;
  /** Exclusive end of the half-open interval. Must be > start. */
  readonly end: number;
}

export interface JoinMatch {
  readonly leftId: string;
  readonly rightId: string;
  /** Inclusive start of the non-empty intersection. */
  readonly start: number;
  /** Exclusive end of the non-empty intersection. */
  readonly end: number;
}

export type PushStatus = "accepted" | "late" | "invalid" | "full";

export interface PushResult {
  readonly status: PushStatus;
  /** Matches produced by this push (empty unless status === "accepted"). */
  readonly matches: readonly JoinMatch[];
}

export interface JoinOptions {
  /** Max retained events on the left side. Must be >= 1. */
  readonly leftCapacity: number;
  /** Max retained events on the right side. Must be >= 1. */
  readonly rightCapacity: number;
}

function other(side: Side): Side {
  return side === "left" ? "right" : "left";
}

export class IntervalJoin {
  private readonly buffers: Record<Side, IntervalEvent[]>;
  private readonly capacities: Record<Side, number>;
  private readonly watermarks: Record<Side, number>;
  private readonly waiters: Array<() => void> = [];

  constructor(options: JoinOptions) {
    if (options.leftCapacity < 1 || options.rightCapacity < 1) {
      throw new RangeError("capacities must be >= 1");
    }
    this.buffers = { left: [], right: [] };
    this.capacities = { left: options.leftCapacity, right: options.rightCapacity };
    this.watermarks = { left: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY };
  }

  watermark(side: Side): number {
    return this.watermarks[side];
  }

  /** Number of currently retained (not yet evicted) events on a side. */
  size(side: Side): number {
    return this.buffers[side].length;
  }

  /** Whether an event with this id is currently retained on a side. */
  has(side: Side, id: string): boolean {
    return this.buffers[side].some((e) => e.id === id);
  }

  /**
   * Offer an event to one side of the join.
   *
   * - "invalid": end <= start; event rejected.
   * - "late": start is behind this side's watermark; event rejected.
   * - "full": side buffer is at capacity (backpressure); event NOT consumed.
   * - "accepted": event joined against the opposite buffer and retained.
   */
  push(side: Side, event: IntervalEvent): PushResult {
    if (!(event.end > event.start)) {
      return { status: "invalid", matches: [] };
    }
    if (event.start < this.watermarks[side]) {
      return { status: "late", matches: [] };
    }
    const buffer = this.buffers[side];
    if (buffer.length >= this.capacities[side]) {
      return { status: "full", matches: [] };
    }

    const opposite = this.buffers[other(side)];
    const matches: JoinMatch[] = [];
    for (const candidate of opposite) {
      const start = Math.max(event.start, candidate.start);
      const end = Math.min(event.end, candidate.end);
      if (start < end) {
        const [leftId, rightId] =
          side === "left" ? [event.id, candidate.id] : [candidate.id, event.id];
        matches.push({ leftId, rightId, start, end });
      }
    }
    buffer.push(event);
    return { status: "accepted", matches };
  }

  /**
   * Like {@link push}, but if the side buffer is full, waits until a future
   * watermark advance evicts enough state to make room. Late/invalid events
   * resolve immediately with their rejection status.
   */
  async pushAsync(side: Side, event: IntervalEvent): Promise<PushResult> {
    let result = this.push(side, event);
    while (result.status === "full") {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
      result = this.push(side, event);
    }
    return result;
  }

  /**
   * Advance a side's watermark (monotone; lower values are ignored) and evict
   * opposite-side items that can no longer match anything (`end <= watermark`).
   * Returns the evicted items.
   */
  advanceWatermark(side: Side, ts: number): IntervalEvent[] {
    if (ts <= this.watermarks[side]) {
      return [];
    }
    this.watermarks[side] = ts;

    const oppositeSide = other(side);
    const kept: IntervalEvent[] = [];
    const evicted: IntervalEvent[] = [];
    for (const item of this.buffers[oppositeSide]) {
      (item.end <= ts ? evicted : kept).push(item);
    }
    this.buffers[oppositeSide] = kept;

    if (evicted.length > 0 && this.waiters.length > 0) {
      const pending = this.waiters.splice(0, this.waiters.length);
      for (const notify of pending) notify();
    }
    return evicted;
  }
}

/**
 * Offline reference: full pairwise join of two finite event collections.
 * Used to cross-check streaming results in tests.
 */
export function fullPairwiseJoin(
  left: readonly IntervalEvent[],
  right: readonly IntervalEvent[],
): JoinMatch[] {
  const matches: JoinMatch[] = [];
  for (const l of left) {
    for (const r of right) {
      const start = Math.max(l.start, r.start);
      const end = Math.min(l.end, r.end);
      if (start < end) {
        matches.push({ leftId: l.id, rightId: r.id, start, end });
      }
    }
  }
  return matches;
}
