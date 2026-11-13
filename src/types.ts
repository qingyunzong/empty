import type { CoordinatorError } from "./errors.ts";

export type ChannelId = string;

export type NumericInput = number | string;

/**
 * A price level can be supplied either as `[price, size]` or as an object.
 * Numeric strings are accepted because many venues serialize decimals that way.
 */
export type LevelInput =
  | readonly [price: NumericInput, size: NumericInput]
  | { readonly price: NumericInput; readonly size: NumericInput };

export interface OrderBookSnapshot {
  readonly channel: ChannelId;
  /** Sequence represented by this snapshot. The next delta should be `sequence + 1`. */
  readonly sequence: number;
  readonly bids: readonly LevelInput[];
  readonly asks: readonly LevelInput[];
  readonly timestamp?: number;
}

export interface OrderBookDelta {
  readonly channel: ChannelId;
  /** Sequence of this delta on the channel's ordered stream. */
  readonly sequence: number;
  readonly bids?: readonly LevelInput[];
  readonly asks?: readonly LevelInput[];
  readonly timestamp?: number;
}

export type FeedMessage =
  | (OrderBookSnapshot & { readonly type: "snapshot" })
  | (OrderBookDelta & { readonly type: "delta" | "update" | "increment" });

export interface OrderBookLevel {
  readonly price: number;
  readonly size: number;
}

export interface OrderBook {
  readonly channel: ChannelId;
  /** Highest contiguous channel sequence reflected in this book. */
  readonly sequence: number;
  /** Sequence of the snapshot from which this book was rebuilt. */
  readonly snapshotSequence: number;
  readonly bids: readonly OrderBookLevel[];
  readonly asks: readonly OrderBookLevel[];
  readonly timestamp?: number;
}

export type ResyncReason =
  | "no-snapshot"
  | "reconnect"
  | "gap"
  | "buffer-overflow"
  | "stale-snapshot"
  | "manual";

export interface SnapshotRequest {
  readonly channel: ChannelId;
  readonly reason: ResyncReason;
  /** Last sequence applied to the published book, if any. */
  readonly lastSequence: number | null;
  /** Sequence of the last accepted snapshot, if any. */
  readonly snapshotSequence: number | null;
  readonly bufferedDeltas: number;
}

export interface BookPublication {
  readonly source: "snapshot" | "delta";
  /** True when the delta came from the reconnect buffer after a snapshot. */
  readonly replayed: boolean;
}

export type SnapshotRequester = (
  request: SnapshotRequest,
) => void | Promise<void>;

export type BookListener = (
  book: OrderBook,
  publication: BookPublication,
) => void;

export type ErrorListener = (error: CoordinatorError) => void;

export interface CoordinatorOptions {
  /**
   * Maximum number of deltas retained while waiting for a snapshot.
   * Defaults to 1024. `0` disables buffering.
   */
  readonly maxBufferedDeltas?: number;
  /** Called whenever a fresh snapshot is required. */
  readonly requestSnapshot?: SnapshotRequester;
  /** Called only for books that are contiguous and internally consistent. */
  readonly onBook?: BookListener;
  readonly onError?: ErrorListener;
}

export type ChannelPhase = "awaiting-snapshot" | "live";

export interface ChannelState {
  readonly channel: ChannelId;
  readonly phase: ChannelPhase;
  readonly synchronized: boolean;
  readonly lastSequence: number | null;
  readonly snapshotSequence: number | null;
  readonly bufferedDeltas: number;
  readonly snapshotRequestPending: boolean;
}

export interface AppliedDeltaResult {
  readonly status: "applied";
  readonly sequence: number;
}

export interface BufferedDeltaResult {
  readonly status: "buffered";
  readonly sequence: number;
  readonly bufferedDeltas: number;
}

export interface DuplicateResult {
  readonly status: "duplicate";
  readonly sequence: number;
}

export interface ResyncResult {
  readonly status: "resync";
  readonly sequence: number;
  readonly reason: ResyncReason;
}

export interface InvalidResult {
  readonly status: "invalid";
  readonly error: CoordinatorError;
}

export type DeltaResult =
  | AppliedDeltaResult
  | BufferedDeltaResult
  | DuplicateResult
  | ResyncResult
  | InvalidResult;

export interface SnapshotAppliedResult {
  readonly status: "applied";
  readonly sequence: number;
  readonly replayedDeltas: number;
  /**
   * True when replay stopped at a sequence gap. The book is consistent up to
   * `sequence`, but another snapshot is required before accepting live deltas.
   */
  readonly resyncRequired: boolean;
}

export interface SnapshotStaleResult {
  readonly status: "stale";
  readonly sequence: number;
  readonly lastSequence: number | null;
}

export type SnapshotResult =
  | SnapshotAppliedResult
  | DuplicateResult
  | SnapshotStaleResult
  | InvalidResult;

export type HandleResult = SnapshotResult | DeltaResult;
