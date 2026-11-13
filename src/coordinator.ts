import {
  applyLevels,
  buildBook,
  buildSnapshotMaps,
  normalizeDelta,
  normalizeSnapshot,
  type NormalizedDelta,
} from "./book.ts";
import { CoordinatorError } from "./errors.ts";
import type {
  BookListener,
  ChannelId,
  ChannelPhase,
  ChannelState,
  CoordinatorOptions,
  DeltaResult,
  ErrorListener,
  FeedMessage,
  HandleResult,
  OrderBook,
  OrderBookDelta,
  OrderBookSnapshot,
  ResyncReason,
  SnapshotRequest,
  SnapshotRequester,
  SnapshotResult,
} from "./types.ts";

const DEFAULT_MAX_BUFFERED_DELTAS = 1024;

interface ChannelRuntime {
  readonly channel: ChannelId;
  phase: ChannelPhase;
  lastSequence: number | null;
  snapshotSequence: number | null;
  bids: Map<number, number>;
  asks: Map<number, number>;
  buffer: Map<number, NormalizedDelta>;
  snapshotRequestPending: boolean;
  timestamp: number | undefined;
}

function isPromiseLike(value: unknown): value is PromiseLike<void> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Coordinates exchange snapshots with a sequence-ordered delta stream.
 *
 * Invariants:
 * - A book is published only when it reflects every channel sequence from its
 *   snapshot baseline through `book.sequence`.
 * - Deltas at or below the last applied sequence are duplicates/stale and are
 *   ignored, making redelivery idempotent.
 * - While waiting for a snapshot, deltas are buffered up to a fixed limit.
 * - A gap or a full buffer invalidates the stream. A snapshot is requested and
 *   no partially rebuilt book is published.
 */
export class SnapshotIncrementalCoordinator {
  private readonly maxBufferedDeltas: number;
  private readonly requestSnapshotCallback: SnapshotRequester | undefined;
  private readonly onBookCallback: BookListener | undefined;
  private readonly onErrorCallback: ErrorListener | undefined;
  private readonly channels = new Map<ChannelId, ChannelRuntime>();

  constructor(options: CoordinatorOptions = {}) {
    const maxBufferedDeltas =
      options.maxBufferedDeltas ?? DEFAULT_MAX_BUFFERED_DELTAS;

    if (
      !Number.isSafeInteger(maxBufferedDeltas) ||
      maxBufferedDeltas < 0
    ) {
      throw new CoordinatorError(
        "invalid-config",
        "maxBufferedDeltas must be a non-negative safe integer",
      );
    }

    this.maxBufferedDeltas = maxBufferedDeltas;
    this.requestSnapshotCallback = options.requestSnapshot;
    this.onBookCallback = options.onBook;
    this.onErrorCallback = options.onError;
  }

  /**
   * Accepts a tagged feed message. Untagged messages can be routed directly to
   * `handleSnapshot` / `handleDelta` instead.
   */
  handleMessage(message: FeedMessage): HandleResult {
    if (typeof message !== "object" || message === null) {
      return this.invalidMessage("feed message must be an object");
    }

    const type = (message as { readonly type?: unknown }).type;
    if (type === "snapshot") {
      return this.handleSnapshot(message as OrderBookSnapshot);
    }
    if (type === "delta" || type === "update" || type === "increment") {
      return this.handleDelta(message);
    }

    return this.invalidMessage(
      'feed message type must be "snapshot", "delta", "update" or "increment"',
    );
  }

  handleDelta(delta: OrderBookDelta): DeltaResult {
    const parsed = normalizeDelta(delta);
    if (!parsed.ok) {
      const error = new CoordinatorError("invalid-delta", parsed.message);
      this.report(error);
      return { status: "invalid", error };
    }

    const next = parsed.value;
    const runtime = this.getOrCreateRuntime(next.channel);

    if (runtime.phase !== "live") {
      if (
        runtime.lastSequence !== null &&
        next.sequence <= runtime.lastSequence
      ) {
        return { status: "duplicate", sequence: next.sequence };
      }

      const reason =
        runtime.snapshotSequence === null ? "no-snapshot" : "gap";
      return this.bufferDelta(runtime, next, reason);
    }

    const lastSequence = runtime.lastSequence;
    if (lastSequence === null) {
      // A live runtime always has a baseline. Treat an impossible state as a
      // missing snapshot instead of applying an unverifiable delta.
      runtime.phase = "awaiting-snapshot";
      return this.bufferDelta(runtime, next, "no-snapshot");
    }

    if (next.sequence <= lastSequence) {
      return { status: "duplicate", sequence: next.sequence };
    }

    if (next.sequence === lastSequence + 1) {
      this.applyDelta(runtime, next);
      this.publish(runtime, "delta", false);
      return { status: "applied", sequence: next.sequence };
    }

    runtime.phase = "awaiting-snapshot";
    const buffered = this.bufferDelta(runtime, next, "gap");
    if (buffered.status === "resync") {
      return buffered;
    }
    return {
      status: "resync",
      sequence: next.sequence,
      reason: "gap",
    };
  }

  handleSnapshot(snapshot: OrderBookSnapshot): SnapshotResult {
    const parsed = normalizeSnapshot(snapshot);
    if (!parsed.ok) {
      const error = new CoordinatorError("invalid-snapshot", parsed.message);
      this.report(error);
      return { status: "invalid", error };
    }

    const next = parsed.value;
    const runtime = this.getOrCreateRuntime(next.channel);

    if (
      runtime.lastSequence !== null &&
      next.sequence < runtime.lastSequence
    ) {
      if (runtime.phase === "awaiting-snapshot") {
        // The response cannot cover the book we already have. A newer
        // snapshot is required before buffered deltas can be replayed.
        this.issueSnapshotRequest(runtime, "stale-snapshot");
      }
      return {
        status: "stale",
        sequence: next.sequence,
        lastSequence: runtime.lastSequence,
      };
    }

    if (
      runtime.phase === "live" &&
      runtime.lastSequence === next.sequence
    ) {
      return { status: "duplicate", sequence: next.sequence };
    }

    // A snapshot replaces both sides. It is never merged into a possibly
    // divergent local book.
    runtime.bids = buildSnapshotMaps(next.bids);
    runtime.asks = buildSnapshotMaps(next.asks);
    runtime.snapshotSequence = next.sequence;
    runtime.lastSequence = next.sequence;
    runtime.phase = "live";
    runtime.snapshotRequestPending = false;
    runtime.timestamp = next.timestamp;

    for (const bufferedSequence of [...runtime.buffer.keys()]) {
      if (bufferedSequence <= next.sequence) {
        runtime.buffer.delete(bufferedSequence);
      }
    }

    this.publish(runtime, "snapshot", false);

    let replayedDeltas = 0;
    let expected = next.sequence + 1;
    for (;;) {
      const buffered = runtime.buffer.get(expected);
      if (buffered === undefined) {
        break;
      }

      runtime.buffer.delete(expected);
      this.applyDelta(runtime, buffered);
      this.publish(runtime, "delta", true);
      replayedDeltas += 1;
      expected += 1;
    }

    const resyncRequired = runtime.buffer.size > 0;
    if (resyncRequired) {
      // Buffered deltas exist beyond a missing sequence. Keep them bounded and
      // ask for another snapshot; do not apply across the gap.
      runtime.phase = "awaiting-snapshot";
      this.issueSnapshotRequest(runtime, "gap");
    }

    return {
      status: "applied",
      sequence: next.sequence,
      replayedDeltas,
      resyncRequired,
    };
  }

  /**
   * Marks a channel (or every known channel) as needing a fresh snapshot.
   * Existing bounded deltas are retained because their channel sequences
   * remain valid across a transport reconnect.
   */
  beginReconnect(channel?: ChannelId): void {
    if (channel === undefined) {
      for (const runtime of this.channels.values()) {
        this.markReconnect(runtime);
      }
      return;
    }

    const runtime = this.getOrCreateRuntime(channel);
    this.markReconnect(runtime);
  }

  /** Explicitly invalidate a channel and request a snapshot. */
  resync(channel: ChannelId, reason: ResyncReason = "manual"): void {
    if (typeof channel !== "string" || channel.trim() === "") {
      throw new CoordinatorError(
        "invalid-config",
        "channel must be a non-empty string",
      );
    }
    this.markReconnect(this.getOrCreateRuntime(channel), reason);
  }

  /** Forgets all state for one channel, or every channel when omitted. */
  reset(channel?: ChannelId): void {
    if (channel === undefined) {
      this.channels.clear();
      return;
    }
    this.channels.delete(channel);
  }

  getState(channel: ChannelId): ChannelState | undefined {
    const runtime = this.channels.get(channel);
    if (runtime === undefined) {
      return undefined;
    }

    return {
      channel: runtime.channel,
      phase: runtime.phase,
      synchronized: runtime.phase === "live",
      lastSequence: runtime.lastSequence,
      snapshotSequence: runtime.snapshotSequence,
      bufferedDeltas: runtime.buffer.size,
      snapshotRequestPending: runtime.snapshotRequestPending,
    };
  }

  isSynchronized(channel: ChannelId): boolean {
    return this.channels.get(channel)?.phase === "live";
  }

  /**
   * Returns the last contiguous book. During a resync this may be the last
   * consistent book before the gap; callers must check `isSynchronized`.
   */
  getBook(channel: ChannelId): OrderBook | undefined {
    const runtime = this.channels.get(channel);
    if (
      runtime === undefined ||
      runtime.lastSequence === null ||
      runtime.snapshotSequence === null
    ) {
      return undefined;
    }

    return buildBook(
      runtime.channel,
      runtime.lastSequence,
      runtime.snapshotSequence,
      runtime.bids,
      runtime.asks,
      runtime.timestamp,
    );
  }

  private getOrCreateRuntime(channel: ChannelId): ChannelRuntime {
    const existing = this.channels.get(channel);
    if (existing !== undefined) {
      return existing;
    }

    const runtime: ChannelRuntime = {
      channel,
      phase: "awaiting-snapshot",
      lastSequence: null,
      snapshotSequence: null,
      bids: new Map<number, number>(),
      asks: new Map<number, number>(),
      buffer: new Map<number, NormalizedDelta>(),
      snapshotRequestPending: false,
      timestamp: undefined,
    };
    this.channels.set(channel, runtime);
    return runtime;
  }

  private markReconnect(
    runtime: ChannelRuntime,
    reason: ResyncReason = "reconnect",
  ): void {
    runtime.phase = "awaiting-snapshot";
    this.issueSnapshotRequest(runtime, reason);
  }

  private bufferDelta(
    runtime: ChannelRuntime,
    delta: NormalizedDelta,
    reason: ResyncReason,
  ): DeltaResult {
    if (runtime.buffer.has(delta.sequence)) {
      return { status: "duplicate", sequence: delta.sequence };
    }

    if (
      this.maxBufferedDeltas === 0 ||
      runtime.buffer.size >= this.maxBufferedDeltas
    ) {
      // Continuity is already lost. Drop the partial buffer, request a fresh
      // snapshot, and retain only the newest delta as a bounded seed.
      runtime.buffer.clear();
      if (this.maxBufferedDeltas > 0) {
        runtime.buffer.set(delta.sequence, delta);
      }
      runtime.phase = "awaiting-snapshot";
      this.issueSnapshotRequest(runtime, "buffer-overflow");
      return {
        status: "resync",
        sequence: delta.sequence,
        reason: "buffer-overflow",
      };
    }

    runtime.buffer.set(delta.sequence, delta);
    if (!runtime.snapshotRequestPending) {
      this.issueSnapshotRequest(runtime, reason);
    }

    return {
      status: "buffered",
      sequence: delta.sequence,
      bufferedDeltas: runtime.buffer.size,
    };
  }

  private applyDelta(
    runtime: ChannelRuntime,
    delta: NormalizedDelta,
  ): void {
    applyLevels(runtime.bids, delta.bids);
    applyLevels(runtime.asks, delta.asks);
    runtime.lastSequence = delta.sequence;
    if (delta.timestamp !== undefined) {
      runtime.timestamp = delta.timestamp;
    }
  }

  private publish(
    runtime: ChannelRuntime,
    source: "snapshot" | "delta",
    replayed: boolean,
  ): void {
    if (
      this.onBookCallback === undefined ||
      runtime.lastSequence === null ||
      runtime.snapshotSequence === null
    ) {
      return;
    }

    const book = buildBook(
      runtime.channel,
      runtime.lastSequence,
      runtime.snapshotSequence,
      runtime.bids,
      runtime.asks,
      runtime.timestamp,
    );

    try {
      this.onBookCallback(book, { source, replayed });
    } catch (cause) {
      this.report(
        new CoordinatorError(
          "listener-failed",
          "onBook listener threw",
          runtime.channel,
          { cause },
        ),
      );
    }
  }

  private issueSnapshotRequest(
    runtime: ChannelRuntime,
    reason: ResyncReason,
  ): void {
    runtime.snapshotRequestPending = true;

    const callback = this.requestSnapshotCallback;
    if (callback === undefined) {
      return;
    }

    const request: SnapshotRequest = {
      channel: runtime.channel,
      reason,
      lastSequence: runtime.lastSequence,
      snapshotSequence: runtime.snapshotSequence,
      bufferedDeltas: runtime.buffer.size,
    };

    try {
      const result = callback(request);
      if (isPromiseLike(result)) {
        Promise.resolve(result).catch((cause: unknown) => {
          runtime.snapshotRequestPending = false;
          this.report(
            new CoordinatorError(
              "snapshot-request-failed",
              "requestSnapshot rejected",
              runtime.channel,
              { cause },
            ),
          );
        });
      }
    } catch (cause) {
      runtime.snapshotRequestPending = false;
      this.report(
        new CoordinatorError(
          "snapshot-request-failed",
          "requestSnapshot threw",
          runtime.channel,
          { cause },
        ),
      );
    }
  }

  private invalidMessage(message: string): HandleResult {
    const error = new CoordinatorError("invalid-message", message);
    this.report(error);
    return { status: "invalid", error };
  }

  private report(error: CoordinatorError): void {
    try {
      this.onErrorCallback?.(error);
    } catch {
      // Error reporting must not break feed processing.
    }
  }
}
