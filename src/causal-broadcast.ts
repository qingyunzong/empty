export type NodeId = string;

/** Vector clock: highest contiguous sequence number known per source. */
export type VectorClock = Record<NodeId, number>;

export interface Message<T = unknown> {
  /** Globally unique message id. */
  id: string;
  /** Id of the node that broadcast the message. */
  source: NodeId;
  /** Per-source sequence number, contiguous starting at 1. */
  seq: number;
  /**
   * Dependency vector: the message may only be delivered once, for every
   * entry (node -> n), all messages from `node` with seq <= n are delivered.
   */
  deps: VectorClock;
  payload: T;
}

/** Why a buffered message cannot be delivered yet. */
export interface PendingReason {
  /**
   * - `source-gap`: earlier sequence numbers from the same source are missing.
   * - `missing-dependency`: a dependency-vector entry is not yet satisfied.
   * - `below-watermark`: the message itself is at or below the declared
   *   watermark of its source and can never be delivered (orphaned).
   */
  kind: "source-gap" | "missing-dependency" | "below-watermark";
  /** The source node we are waiting on. */
  source: NodeId;
  /** Highest contiguous seq already delivered from that source. */
  have: number;
  /** Seq required before the message can be delivered. */
  need: number;
}

export type ReceiveStatus = "delivered" | "buffered" | "duplicate" | "rejected";

export interface ReceiveResult<T = unknown> {
  status: ReceiveStatus;
  /** Messages delivered as a consequence of this call (cascade), in order. */
  delivered: Message<T>[];
  /** Rejection reason, when status is "rejected". */
  reason?: string;
  /** Why the message was buffered, when status is "buffered". */
  pending?: PendingReason[];
}

export interface PendingEntry<T = unknown> {
  message: Message<T>;
  reasons: PendingReason[];
}

export interface WatermarkResult<T = unknown> {
  /** Buffered messages dropped because the watermark passed their seq. */
  orphaned: PendingEntry<T>[];
  /** Buffered messages unblocked by the advanced frontier, in order. */
  delivered: Message<T>[];
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Deterministic stringify with sorted object keys, used for content identity. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + stableStringify(record[k])).join(",") +
    "}"
  );
}

function contentFingerprint(msg: Message<unknown>): string {
  return stableStringify({
    source: msg.source,
    seq: msg.seq,
    deps: msg.deps,
    payload: msg.payload,
  });
}

/**
 * Simulates one node in a causal broadcast protocol.
 *
 * Delivery rule: a message is delivered exactly when it is the next expected
 * sequence number from its source AND every entry of its dependency vector is
 * already satisfied by the delivered set. Otherwise it is buffered. Delivery
 * of a message may unblock buffered ones (cascade), preserving causal order.
 */
export class CausalBroadcast<T = unknown> {
  private deliveredClock: VectorClock = {};
  private readonly log: Message<T>[] = [];
  private readonly fingerprints = new Map<string, string>();
  private readonly buffer = new Map<string, Message<T>>();
  private readonly watermarks: VectorClock = {};
  private readonly orphaned: PendingEntry<T>[] = [];

  /** Delivered messages, in causal delivery order. */
  delivered(): readonly Message<T>[] {
    return this.log;
  }

  /** Copy of the current delivered vector clock. */
  clock(): VectorClock {
    return { ...this.deliveredClock };
  }

  /** Copy of the declared watermarks. */
  watermark(): VectorClock {
    return { ...this.watermarks };
  }

  /** Buffered messages that can never be delivered (dropped by watermarks). */
  orphans(): readonly PendingEntry<T>[] {
    return this.orphaned;
  }

  /** All buffered messages with their current pending reasons. */
  pending(): PendingEntry<T>[] {
    return [...this.buffer.values()].map((message) => ({
      message,
      reasons: this.missing(message),
    }));
  }

  /** Pending reasons for one buffered message, or undefined if not buffered. */
  pendingReasons(id: string): PendingReason[] | undefined {
    const msg = this.buffer.get(id);
    return msg ? this.missing(msg) : undefined;
  }

  /**
   * Declare that no message with `seq <= clock[source]` will ever arrive
   * again from `source`. Watermarks are monotone per source.
   *
   * Declaring a watermark past the delivered frontier explicitly skips the
   * missing prefix: the next expected seq from that source becomes
   * `watermark + 1`, and dependency-vector entries at or below the watermark
   * are considered waived by the declaration. Buffered messages from that
   * source with `seq <= watermark` can never be delivered and are orphaned.
   */
  declareWatermark(clock: VectorClock): WatermarkResult<T> {
    for (const [node, w] of Object.entries(clock)) {
      if (!isNonNegativeInteger(w)) {
        throw new Error(`watermark for ${node} must be a non-negative integer`);
      }
      const current = this.watermarks[node] ?? 0;
      if (w < current) {
        throw new Error(
          `watermark for ${node} cannot decrease (${current} -> ${w})`,
        );
      }
    }
    Object.assign(this.watermarks, clock);
    const orphaned = this.evictOrphans();
    const delivered = this.drainBuffer();
    return { orphaned, delivered };
  }

  /** Feed one incoming message to the node. */
  receive(msg: Message<T>): ReceiveResult<T> {
    const malformed = this.validate(msg);
    if (malformed) {
      return { status: "rejected", delivered: [], reason: malformed };
    }

    const fingerprint = contentFingerprint(msg as Message<unknown>);
    const known = this.fingerprints.get(msg.id);
    if (known !== undefined) {
      if (known === fingerprint) {
        return { status: "duplicate", delivered: [] };
      }
      return {
        status: "rejected",
        delivered: [],
        reason: `conflicting content for message id "${msg.id}"`,
      };
    }

    const watermark = this.watermarks[msg.source] ?? 0;
    if (msg.seq <= watermark) {
      return {
        status: "rejected",
        delivered: [],
        reason: `stale message ${msg.source}#${msg.seq} at or below watermark ${watermark}`,
      };
    }

    this.fingerprints.set(msg.id, fingerprint);

    const reasons = this.missing(msg);
    if (reasons.length > 0) {
      this.buffer.set(msg.id, msg);
      return { status: "buffered", delivered: [], pending: reasons };
    }

    const delivered = this.deliverCascade(msg);
    return { status: "delivered", delivered };
  }

  private validate(msg: Message<T>): string | undefined {
    if (!msg || typeof msg.id !== "string" || msg.id.length === 0) {
      return "message id must be a non-empty string";
    }
    if (typeof msg.source !== "string" || msg.source.length === 0) {
      return "message source must be a non-empty string";
    }
    if (!isNonNegativeInteger(msg.seq) || msg.seq < 1) {
      return "message seq must be a positive integer";
    }
    if (!msg.deps || typeof msg.deps !== "object" || Array.isArray(msg.deps)) {
      return "message deps must be a vector clock object";
    }
    for (const [node, n] of Object.entries(msg.deps)) {
      if (!isNonNegativeInteger(n)) {
        return `deps[${node}] must be a non-negative integer`;
      }
    }
    const selfDep = msg.deps[msg.source];
    if (selfDep !== undefined && selfDep > msg.seq - 1) {
      return `deps[source] (${selfDep}) cannot exceed seq - 1 (${msg.seq - 1})`;
    }
    return undefined;
  }

  /** Reasons why `msg` cannot be delivered right now (empty = deliverable). */
  private missing(msg: Message<T>): PendingReason[] {
    const reasons: PendingReason[] = [];
    const frontier = this.frontier(msg.source);
    if (msg.seq > frontier + 1) {
      reasons.push({
        kind: "source-gap",
        source: msg.source,
        have: frontier,
        need: msg.seq - 1,
      });
    }
    for (const [node, n] of Object.entries(msg.deps)) {
      if (node === msg.source) continue;
      const have = this.deliveredClock[node] ?? 0;
      const waived = n <= (this.watermarks[node] ?? 0);
      if (have < n && !waived) {
        reasons.push({
          kind: "missing-dependency",
          source: node,
          have,
          need: n,
        });
      }
    }
    return reasons;
  }

  /** Delivered seq, or the watermark if it skipped further ahead. */
  private frontier(source: NodeId): number {
    return Math.max(
      this.deliveredClock[source] ?? 0,
      this.watermarks[source] ?? 0,
    );
  }

  private deliverCascade(first: Message<T>): Message<T>[] {
    const out: Message<T>[] = [];
    const queue: Message<T>[] = [first];
    while (queue.length > 0) {
      const msg = queue.shift() as Message<T>;
      this.deliveredClock[msg.source] = msg.seq;
      this.log.push(msg);
      out.push(msg);
      // Scan in insertion order for deterministic cascade order.
      for (const [id, candidate] of [...this.buffer]) {
        if (this.missing(candidate).length === 0) {
          this.buffer.delete(id);
          queue.push(candidate);
        }
      }
    }
    return out;
  }

  private evictOrphans(): PendingEntry<T>[] {
    const evicted: PendingEntry<T>[] = [];
    for (const [id, msg] of [...this.buffer]) {
      const watermark = this.watermarks[msg.source] ?? 0;
      if (msg.seq <= watermark) {
        this.buffer.delete(id);
        const entry: PendingEntry<T> = {
          message: msg,
          reasons: [
            {
              kind: "below-watermark",
              source: msg.source,
              have: watermark,
              need: msg.seq,
            },
          ],
        };
        this.orphaned.push(entry);
        evicted.push(entry);
      }
    }
    return evicted;
  }

  /** Deliver every buffered message that has become deliverable. */
  private drainBuffer(): Message<T>[] {
    const out: Message<T>[] = [];
    let ready: Message<T> | undefined;
    do {
      ready = undefined;
      for (const [id, candidate] of [...this.buffer]) {
        if (this.missing(candidate).length === 0) {
          this.buffer.delete(id);
          ready = candidate;
          break;
        }
      }
      if (ready) {
        out.push(...this.deliverCascade(ready));
      }
    } while (ready);
    return out;
  }
}

/**
 * Reference check: is `log` a valid causal delivery order (a linear
 * extension of the causal partial order)? Every message must be the next
 * sequence from its source, and every dependency must be satisfied by
 * earlier entries in the log.
 */
export function verifyCausalOrder<T>(log: readonly Message<T>[]): boolean {
  const clock: VectorClock = {};
  const seenIds = new Set<string>();
  for (const msg of log) {
    if (seenIds.has(msg.id)) return false;
    seenIds.add(msg.id);
    if (msg.seq !== (clock[msg.source] ?? 0) + 1) return false;
    for (const [node, n] of Object.entries(msg.deps)) {
      if (node === msg.source) continue;
      if ((clock[node] ?? 0) < n) return false;
    }
    clock[msg.source] = msg.seq;
  }
  return true;
}
