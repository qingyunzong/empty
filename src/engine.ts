import {
  Change,
  EngineOptions,
  ObjectState,
  ReceiveStatus,
  Snapshot,
} from "./types";

const DEFAULT_MAX_BUFFERED = 1024;

function isWellFormed<V>(change: Change<V>): boolean {
  return (
    typeof change.key === "string" &&
    Number.isInteger(change.version) &&
    Number.isInteger(change.prev) &&
    change.prev >= 0 &&
    change.version > change.prev &&
    (change.op === "put" || change.op === "delete")
  );
}

/**
 * Causal sync engine.
 *
 * - Receives changes tagged with their predecessor version.
 * - Applies a change only when its predecessor is the current cursor;
 *   otherwise the change waits in a bounded pending buffer.
 * - Deletes advance the cursor exactly like puts (tombstones).
 * - When the buffer budget is full, receive() reports "backpressure" and
 *   rejects the change; the caller must retry after the buffer drains.
 * - snapshot()/restore() round-trip applied state, cursors and the pending
 *   buffer, so recovery never loses in-flight out-of-order changes.
 */
export class SyncEngine<V = unknown> {
  private readonly maxBuffered: number;
  private readonly state = new Map<string, ObjectState<V>>();
  private readonly cursors = new Map<string, number>();
  /** key -> (prev version the change waits on -> change) */
  private readonly pendingByPrev = new Map<string, Map<number, Change<V>>>();
  /** key -> buffered versions, for duplicate detection */
  private readonly pendingVersions = new Map<string, Set<number>>();
  private buffered = 0;

  constructor(options: EngineOptions = {}) {
    this.maxBuffered = options.maxBuffered ?? DEFAULT_MAX_BUFFERED;
  }

  /** Last applied version for a key (0 if never seen). Deletes included. */
  cursor(key: string): number {
    return this.cursors.get(key) ?? 0;
  }

  /** Current live value, or undefined if absent/deleted. */
  get(key: string): ObjectState<V> | undefined {
    return this.state.get(key);
  }

  get bufferedCount(): number {
    return this.buffered;
  }

  get budgetRemaining(): number {
    return this.maxBuffered - this.buffered;
  }

  *entries(): IterableIterator<readonly [string, ObjectState<V>]> {
    yield* this.state.entries();
  }

  receive(change: Change<V>): ReceiveStatus {
    if (!isWellFormed(change)) return "invalid";

    const cursor = this.cursor(change.key);
    if (change.version <= cursor) return "stale";
    if (change.prev < cursor) {
      // Predecessor already applied yet this change was not: the applied
      // history took a different chain. Refusing to guess.
      return "invalid";
    }
    if (this.pendingVersions.get(change.key)?.has(change.version)) {
      return "duplicate";
    }

    if (change.prev === cursor) {
      this.apply(change);
      this.drain(change.key);
      return "applied";
    }

    if (this.buffered >= this.maxBuffered) return "backpressure";
    this.bufferPending(change);
    return "buffered";
  }

  snapshot(): Snapshot<V> {
    const pending: Change<V>[] = [];
    for (const byPrev of this.pendingByPrev.values()) {
      for (const change of byPrev.values()) pending.push(change);
    }
    return {
      formatVersion: 1,
      maxBuffered: this.maxBuffered,
      state: [...this.state.entries()].map(([key, s]) => [
        key,
        { value: s.value, version: s.version },
      ]),
      cursors: [...this.cursors.entries()],
      pending,
    };
  }

  /**
   * Rebuild an engine from a snapshot. Pending changes are always preserved,
   * even if a smaller maxBuffered override is supplied; the budget only
   * gates newly received changes.
   */
  static restore<V = unknown>(
    snap: Snapshot<V>,
    options: EngineOptions = {},
  ): SyncEngine<V> {
    if (snap.formatVersion !== 1) {
      throw new Error(`unsupported snapshot format: ${snap.formatVersion}`);
    }
    const engine = new SyncEngine<V>({
      maxBuffered: options.maxBuffered ?? snap.maxBuffered,
    });
    for (const [key, s] of snap.state) {
      engine.state.set(key, { value: s.value, version: s.version });
    }
    for (const [key, version] of snap.cursors) {
      engine.cursors.set(key, version);
    }
    for (const change of snap.pending) {
      engine.bufferPending(change);
    }
    return engine;
  }

  private apply(change: Change<V>): void {
    if (change.op === "put") {
      this.state.set(change.key, {
        value: change.value as V,
        version: change.version,
      });
    } else {
      this.state.delete(change.key);
    }
    // Deletes advance the cursor too: the tombstone IS the new version.
    this.cursors.set(change.key, change.version);
  }

  private drain(key: string): void {
    const byPrev = this.pendingByPrev.get(key);
    if (!byPrev) return;
    for (;;) {
      const next = byPrev.get(this.cursor(key));
      if (!next) return;
      byPrev.delete(next.prev);
      this.pendingVersions.get(key)?.delete(next.version);
      this.buffered -= 1;
      this.apply(next);
    }
  }

  private bufferPending(change: Change<V>): void {
    let byPrev = this.pendingByPrev.get(change.key);
    if (!byPrev) {
      byPrev = new Map();
      this.pendingByPrev.set(change.key, byPrev);
    }
    byPrev.set(change.prev, change);
    let versions = this.pendingVersions.get(change.key);
    if (!versions) {
      versions = new Set();
      this.pendingVersions.set(change.key, versions);
    }
    versions.add(change.version);
    this.buffered += 1;
  }
}
