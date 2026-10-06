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
/**
 * Tracks per-partition progress and publishes the global watermark as the
 * minimum max-event-time across currently ACTIVE partitions. Idle partitions
 * (declared via explicit `idle` events) are excluded from the minimum.
 *
 * A data event whose event time is earlier than the already-published global
 * watermark is rejected and recorded; it never mutates partition state.
 */
export declare class WatermarkTracker {
    private readonly partitions;
    private published;
    private readonly trajectory;
    private readonly rejections;
    /** Apply one event. Returns true if a new global watermark was published. */
    apply(event: StreamEvent, eventIndex?: number): boolean;
    /**
     * Replay an event stream from a fresh tracker and return the full
     * trajectory plus rejections. Verifies that the published watermark is
     * monotonically non-decreasing; throws if a regression is detected.
     */
    static replay(events: readonly StreamEvent[]): ReplayResult;
    result(): ReplayResult;
    currentWatermark(): number | null;
    private stateFor;
    private recompute;
}
