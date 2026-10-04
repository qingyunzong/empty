import type {
  AlertEvent,
  Batch,
  ChangeSource,
  DisplayChange,
  SubscriptionMessage,
  TimeWindow,
} from "./types.js";
import { compareEvents } from "./types.js";

export interface SubscribeOptions {
  /**
   * Maximum number of undelivered batches a subscription may buffer.
   * Exceeding the quota converts the subscription to a resync.
   * Defaults to unbounded.
   */
  maxQueue?: number;
}

export interface Subscription {
  readonly id: number;
  readonly closed: boolean;
  /**
   * Publish the initial snapshot. Mutations between `subscribe()` and this
   * call are buffered as corrections and replayed after the snapshot.
   * Called implicitly on the first `drain()`.
   */
  publishSnapshot(): void;
  /** Pull all pending messages (snapshot/batches/resync) in order. */
  drain(): SubscriptionMessage[];
  close(): void;
}

interface Snapshot {
  readonly version: number;
  readonly items: readonly AlertEvent[];
}

/**
 * Alert store keyed by `key`. Within the sliding window [start, end) only the
 * earliest event per key is displayed (ties broken by id). Deleting the
 * earliest event promotes the next-earliest one. Every mutation commits one
 * batch with a monotonically increasing version and netted display changes.
 */
export class AlertWindowStore {
  private win: TimeWindow;
  private readonly eventsById = new Map<string, AlertEvent>();
  /** key -> events sorted by (time, id). */
  private readonly sortedByKey = new Map<string, AlertEvent[]>();
  /** key -> currently displayed event. */
  private readonly displayed = new Map<string, AlertEvent>();
  private version = 0;

  private depth = 0;
  private batchBefore: Map<string, AlertEvent> | null = null;
  private batchSource: ChangeSource = "transaction";

  private readonly subs = new Set<SubscriptionImpl>();
  private nextSubId = 1;

  constructor(window: TimeWindow) {
    if (!(window.start <= window.end)) {
      throw new RangeError("window.start must be <= window.end");
    }
    this.win = { start: window.start, end: window.end };
  }

  get currentVersion(): number {
    return this.version;
  }

  get currentWindow(): TimeWindow {
    return { start: this.win.start, end: this.win.end };
  }

  get size(): number {
    return this.eventsById.size;
  }

  has(id: string): boolean {
    return this.eventsById.has(id);
  }

  /** Current display set, sorted by key for deterministic output. */
  display(): AlertEvent[] {
    return [...this.displayed.values()].sort((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
    );
  }

  /** Copy of the current display set as key -> event. */
  displayedMap(): Map<string, AlertEvent> {
    return new Map(this.displayed);
  }

  snapshot(): Snapshot {
    return { version: this.version, items: this.display() };
  }

  /** Insert or replace an event. Commits one batch with source "upsert". */
  upsert(event: AlertEvent): Batch | null {
    this.beginBatch("upsert");
    let batch: Batch | null = null;
    try {
      const prev = this.eventsById.get(event.id);
      if (prev) this.removeFromIndex(prev);
      this.eventsById.set(event.id, event);
      let list = this.sortedByKey.get(event.key);
      if (!list) {
        list = [];
        this.sortedByKey.set(event.key, list);
      }
      list.splice(lowerBound(list, event), 0, event);
      this.recomputeKey(event.key);
      if (prev && prev.key !== event.key) this.recomputeKey(prev.key);
    } finally {
      batch = this.endBatch();
    }
    return batch;
  }

  /** Remove an event by id. Commits one batch with source "remove". */
  remove(id: string): Batch | null {
    this.beginBatch("remove");
    let batch: Batch | null = null;
    try {
      const prev = this.eventsById.get(id);
      if (prev) {
        this.removeFromIndex(prev);
        this.recomputeKey(prev.key);
      }
    } finally {
      batch = this.endBatch();
    }
    return batch;
  }

  /** Move the sliding window. Commits one batch with source "window". */
  moveWindow(start: number, end: number): Batch | null {
    if (!(start <= end)) {
      throw new RangeError("window.start must be <= window.end");
    }
    this.beginBatch("window");
    let batch: Batch | null = null;
    try {
      this.win = { start, end };
      for (const key of this.sortedByKey.keys()) this.recomputeKey(key);
    } finally {
      batch = this.endBatch();
    }
    return batch;
  }

  /**
   * Run several mutations as a single batch (source "transaction"). Changes
   * are netted across the whole batch: an item added and removed inside the
   * same transaction never appears in the resulting changes.
   */
  transaction(fn: () => void): Batch {
    this.beginBatch("transaction");
    let batch: Batch | null = null;
    try {
      fn();
    } finally {
      batch = this.endBatch();
    }
    return batch!;
  }

  subscribe(options: SubscribeOptions = {}): Subscription {
    const sub = new SubscriptionImpl(
      this,
      this.nextSubId++,
      options.maxQueue ?? Number.POSITIVE_INFINITY,
    );
    this.subs.add(sub);
    return sub;
  }

  /** @internal */
  unsubscribe(sub: SubscriptionImpl): void {
    this.subs.delete(sub);
  }

  private beginBatch(source: ChangeSource): void {
    if (this.depth === 0) {
      this.batchBefore = new Map(this.displayed);
      this.batchSource = source;
    }
    this.depth++;
  }

  private endBatch(): Batch | null {
    this.depth--;
    if (this.depth > 0) return null;
    return this.commit();
  }

  private commit(): Batch {
    const before = this.batchBefore!;
    this.batchBefore = null;
    this.version++;
    const changes = diffDisplayed(before, this.displayed);
    const batch: Batch = { version: this.version, source: this.batchSource, changes };
    for (const sub of this.subs) sub.enqueue(batch);
    return batch;
  }

  private removeFromIndex(event: AlertEvent): void {
    this.eventsById.delete(event.id);
    const list = this.sortedByKey.get(event.key);
    if (!list) return;
    const idx = lowerBound(list, event);
    if (idx < list.length && list[idx].id === event.id) list.splice(idx, 1);
    if (list.length === 0) this.sortedByKey.delete(event.key);
  }

  /** Recompute the displayed event for one key under the current window. */
  private recomputeKey(key: string): void {
    const list = this.sortedByKey.get(key);
    let next: AlertEvent | undefined;
    if (list) {
      // First event with time >= window.start; displayed iff time < window.end.
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (list[mid].time < this.win.start) lo = mid + 1;
        else hi = mid;
      }
      if (lo < list.length && list[lo].time < this.win.end) next = list[lo];
    }
    if (next) this.displayed.set(key, next);
    else this.displayed.delete(key);
  }
}

class SubscriptionImpl implements Subscription {
  readonly id: number;
  private readonly store: AlertWindowStore;
  private readonly maxQueue: number;
  private published = false;
  private pendingSnapshot: Snapshot | null;
  private queue: SubscriptionMessage[] = [];
  private queuedBatches = 0;
  private overflowed = false;
  private deliveredVersion: number | null = null;
  private isClosed = false;

  constructor(store: AlertWindowStore, id: number, maxQueue: number) {
    this.store = store;
    this.id = id;
    this.maxQueue = maxQueue;
    // Captured eagerly: corrections after this point are buffered and
    // replayed on top of the snapshot once it is published.
    this.pendingSnapshot = store.snapshot();
  }

  get closed(): boolean {
    return this.isClosed;
  }

  enqueue(batch: Batch): void {
    if (this.isClosed || this.overflowed) return;
    this.queue.push({
      kind: "batch",
      version: batch.version,
      source: batch.source,
      changes: batch.changes,
    });
    this.queuedBatches++;
    if (this.queuedBatches > this.maxQueue) {
      // Slow subscriber exceeded its quota: drop deltas, switch to resync.
      this.overflowed = true;
      this.queue = [];
      this.queuedBatches = 0;
    }
  }

  publishSnapshot(): void {
    if (this.isClosed || this.published) return;
    this.published = true;
    if (this.overflowed) {
      // Corrections outgrew the quota before the snapshot was even
      // published: discard the stale snapshot and re-capture at the
      // current version instead.
      this.overflowed = false;
      const snap = this.store.snapshot();
      this.queue.push({ kind: "snapshot", version: snap.version, items: snap.items });
      return;
    }
    const snap = this.pendingSnapshot!;
    this.pendingSnapshot = null;
    this.queue.unshift({ kind: "snapshot", version: snap.version, items: snap.items });
  }

  drain(): SubscriptionMessage[] {
    if (this.isClosed) return [];
    if (!this.published) this.publishSnapshot();
    if (this.overflowed) {
      this.overflowed = false;
      const snap = this.store.snapshot();
      // fromVersion chains to the last delivered version: no version is lost,
      // the resync atomically covers (fromVersion, version].
      this.queue.push({
        kind: "resync",
        fromVersion: this.deliveredVersion,
        version: snap.version,
        items: snap.items,
      });
    }
    const out = this.queue;
    this.queue = [];
    this.queuedBatches = 0;
    if (out.length > 0) this.deliveredVersion = out[out.length - 1].version;
    return out;
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.queue = [];
    this.store.unsubscribe(this);
  }
}

/** First index at which `event` belongs in a (time, id)-sorted list. */
function lowerBound(list: readonly AlertEvent[], event: AlertEvent): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareEvents(list[mid], event) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Netted difference between two display sets. Because it compares the sets
 * directly, anything cancelled within the batch never shows up. Output order
 * is deterministic: by key, removals before additions, then by (time, id).
 */
export function diffDisplayed(
  before: ReadonlyMap<string, AlertEvent>,
  after: ReadonlyMap<string, AlertEvent>,
): DisplayChange[] {
  const changes: DisplayChange[] = [];
  for (const [key, prev] of before) {
    const now = after.get(key);
    if (!now || now.id !== prev.id) changes.push({ type: "removed", event: prev });
  }
  for (const [key, now] of after) {
    const prev = before.get(key);
    if (!prev || prev.id !== now.id) changes.push({ type: "added", event: now });
  }
  changes.sort((a, b) => {
    if (a.event.key !== b.event.key) return a.event.key < b.event.key ? -1 : 1;
    if (a.type !== b.type) return a.type === "removed" ? -1 : 1;
    return compareEvents(a.event, b.event);
  });
  return changes;
}
