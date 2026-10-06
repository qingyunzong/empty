import type { StreamEvent } from "./events.js";

export interface Rejection {
  readonly partition: string;
  readonly eventTime: number;
  readonly publishedWatermark: number;
  readonly reason: "LATE_DATA";
}

export interface WatermarkTick {
  /** Sequence number of the event (0-based) that caused this publication. */
  readonly atEventIndex: number;
  readonly watermark: number;
}

export interface ReplayResult {
  /** Global watermark trajectory: one entry per (strictly advancing) publication. */
  readonly trajectory: readonly WatermarkTick[];
  /** All rejected late-data events, in arrival order. */
  readonly rejections: readonly Rejection[];
  /** Final published watermark, or null if none was ever published. */
  readonly finalWatermark: number | null;
}

interface PartitionState {
  active: boolean;
  /** Max event time accepted so far on this partition; null if no data yet. */
  maxEventTime: number | null;
}

/**
 * Tracks per-partition progress and publishes the global watermark as the
 * minimum max-event-time across currently ACTIVE partitions. Idle partitions
 * (declared via explicit `idle` events) are excluded from the minimum.
 *
 * A data event whose event time is earlier than the already-published global
 * watermark is rejected and recorded; it never mutates partition state.
 */
export class WatermarkTracker {
  private readonly partitions = new Map<string, PartitionState>();
  private published: number | null = null;
  private readonly trajectory: WatermarkTick[] = [];
  private readonly rejections: Rejection[] = [];

  /** Apply one event. Returns true if a new global watermark was published. */
  apply(event: StreamEvent, eventIndex = this.trajectory.length): boolean {
    switch (event.kind) {
      case "idle": {
        const state = this.stateFor(event.partition);
        state.active = false;
        return this.recompute(eventIndex);
      }
      case "active": {
        const state = this.stateFor(event.partition);
        state.active = true;
        return this.recompute(eventIndex);
      }
      case "data": {
        if (this.published !== null && event.eventTime < this.published) {
          this.rejections.push({
            partition: event.partition,
            eventTime: event.eventTime,
            publishedWatermark: this.published,
            reason: "LATE_DATA",
          });
          return false;
        }
        const state = this.stateFor(event.partition);
        state.active = true; // arriving data is an explicit liveness signal
        if (state.maxEventTime === null || event.eventTime > state.maxEventTime) {
          state.maxEventTime = event.eventTime;
        }
        return this.recompute(eventIndex);
      }
    }
  }

  /**
   * Replay an event stream from a fresh tracker and return the full
   * trajectory plus rejections. Verifies that the published watermark is
   * monotonically non-decreasing; throws if a regression is detected.
   */
  static replay(events: readonly StreamEvent[]): ReplayResult {
    const tracker = new WatermarkTracker();
    events.forEach((event, index) => tracker.apply(event, index));
    return tracker.result();
  }

  result(): ReplayResult {
    for (let i = 1; i < this.trajectory.length; i++) {
      const prev = this.trajectory[i - 1]!;
      const curr = this.trajectory[i]!;
      if (curr.watermark < prev.watermark) {
        throw new Error(
          `watermark regression at event ${curr.atEventIndex}: ` +
            `${curr.watermark} < ${prev.watermark}`,
        );
      }
    }
    return {
      trajectory: [...this.trajectory],
      rejections: [...this.rejections],
      finalWatermark: this.published,
    };
  }

  currentWatermark(): number | null {
    return this.published;
  }

  private stateFor(partition: string): PartitionState {
    let state = this.partitions.get(partition);
    if (state === undefined) {
      state = { active: true, maxEventTime: null };
      this.partitions.set(partition, state);
    }
    return state;
  }

  private recompute(eventIndex: number): boolean {
    let min: number | null = null;
    for (const state of this.partitions.values()) {
      if (!state.active || state.maxEventTime === null) continue;
      if (min === null || state.maxEventTime < min) min = state.maxEventTime;
    }
    if (min === null) return false;
    if (this.published !== null && min <= this.published) return false;
    this.published = min;
    this.trajectory.push({ atEventIndex: eventIndex, watermark: min });
    return true;
  }
}
