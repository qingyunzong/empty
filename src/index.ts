/**
 * Versioned snapshot/delta subscription library.
 *
 * Invariants guaranteed to every subscriber:
 *
 * 1. The first message is a versioned snapshot. Deltas that arrive while the
 *    snapshot promise is still in flight are delivered *after* the snapshot,
 *    with consecutive versions (snapshot.version + 1, + 2, ...).
 * 2. Versions are never skipped silently. If a per-subscription buffer
 *    overflows (slow consumer) or the shared delta log is trimmed past a
 *    lagging subscriber, an explicit `resync` message (a fresh versioned
 *    snapshot) is emitted and the stream continues consecutively from there.
 * 3. `close()` interleaved with an in-flight snapshot promise never
 *    resurrects the subscription: once closed, no message is emitted and the
 *    subscriber stays unregistered.
 * 4. Reentrant updates (an update triggered from an update listener or from
 *    within message consumption) receive later, consecutive versions and are
 *    delivered in version order.
 */

export type Message<T, D> =
  | { readonly type: "snapshot"; readonly version: number; readonly state: T }
  | { readonly type: "delta"; readonly version: number; readonly delta: D }
  | { readonly type: "resync"; readonly version: number; readonly state: T };

export interface StoreOptions {
  /** Maximum number of deltas retained in the shared log. Default 1024. */
  maxLog?: number;
  /**
   * Artificial delay (ms) before a captured snapshot promise resolves.
   * Simulates slow snapshot serialization; deltas published during this
   * window are replayed after the snapshot. Default 0.
   */
  snapshotDelayMs?: number;
}

export interface SubscribeOptions {
  /**
   * Maximum number of undelivered messages buffered per subscription.
   * On overflow an explicit resync is emitted. Default 256.
   */
  maxBuffer?: number;
}

interface LogEntry<D> {
  version: number;
  delta: D;
}

interface Snapshot<T> {
  version: number;
  state: T;
}

const DEFAULT_MAX_LOG = 1024;
const DEFAULT_MAX_BUFFER = 256;

export class VersionedStore<T, D> {
  private state: T;
  private version = 0;
  private log: LogEntry<D>[] = [];
  private logBase = 1; // version of log[0]
  private readonly maxLog: number;
  private readonly snapshotDelayMs: number;
  private readonly subscribers = new Set<Subscription<T, D>>();
  private readonly updateListeners = new Set<(version: number, delta: D) => void>();

  constructor(initialState: T, options: StoreOptions = {}) {
    this.state = initialState;
    this.maxLog = options.maxLog ?? DEFAULT_MAX_LOG;
    this.snapshotDelayMs = options.snapshotDelayMs ?? 0;
  }

  get currentVersion(): number {
    return this.version;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  onUpdate(listener: (version: number, delta: D) => void): () => void {
    this.updateListeners.add(listener);
    return () => {
      this.updateListeners.delete(listener);
    };
  }

  /**
   * Applies a mutation synchronously, bumps the version, appends the delta
   * to the shared log and notifies listeners/subscribers. Reentrant calls
   * (from listeners or subscribers) simply receive the next version.
   */
  update(mutate: (state: T) => D): number {
    const delta = mutate(this.state);
    this.version += 1;
    this.log.push({ version: this.version, delta });
    if (this.log.length > this.maxLog) {
      this.log.shift();
      this.logBase += 1;
    }
    for (const listener of [...this.updateListeners]) {
      listener(this.version, delta);
    }
    for (const sub of [...this.subscribers]) {
      sub.onPublish();
    }
    return this.version;
  }

  subscribe(options: SubscribeOptions = {}): Subscription<T, D> {
    return new Subscription<T, D>(this, options);
  }

  /** @internal */
  _register(sub: Subscription<T, D>): void {
    this.subscribers.add(sub);
  }

  /** @internal */
  _unregister(sub: Subscription<T, D>): void {
    this.subscribers.delete(sub);
  }

  /**
   * Captures the snapshot synchronously (version + deep-cloned state) and
   * resolves it after the configured delay. @internal
   */
  _captureSnapshot(): Promise<Snapshot<T>> {
    const snapshot: Snapshot<T> = {
      version: this.version,
      state: structuredClone(this.state),
    };
    if (this.snapshotDelayMs <= 0) {
      return Promise.resolve(snapshot);
    }
    return new Promise((resolve) => {
      setTimeout(() => resolve(snapshot), this.snapshotDelayMs);
    });
  }

  /** @internal */
  _currentSnapshot(): Snapshot<T> {
    return { version: this.version, state: structuredClone(this.state) };
  }

  /**
   * Returns log entries with version >= `version`, or null when those
   * entries have already been trimmed (caller must resync). @internal
   */
  _logFrom(version: number): LogEntry<D>[] | null {
    if (version < this.logBase) return null;
    if (version > this.version) return [];
    return this.log.slice(version - this.logBase);
  }
}

type Phase = "starting" | "live" | "closed";

export class Subscription<T, D> implements AsyncIterable<Message<T, D>> {
  private readonly store: VersionedStore<T, D>;
  private readonly maxBuffer: number;
  private queue: Message<T, D>[] = [];
  private waiter: (() => void) | null = null;
  private phase: Phase = "starting";
  private nextVersion: number | null = null;
  private readonly startPromise: Promise<void>;

  constructor(store: VersionedStore<T, D>, options: SubscribeOptions) {
    this.store = store;
    this.maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    store._register(this);
    this.startPromise = this.start();
  }

  get closed(): boolean {
    return this.phase === "closed";
  }

  private async start(): Promise<void> {
    let snapshot: Snapshot<T>;
    try {
      snapshot = await this.store._captureSnapshot();
    } catch {
      this.terminate();
      return;
    }
    // A close() that interleaved with the in-flight snapshot promise must
    // not resurrect the subscription: emit nothing, stay unregistered.
    if (this.phase === "closed") return;
    this.queue.push({
      type: "snapshot",
      version: snapshot.version,
      state: snapshot.state,
    });
    this.nextVersion = snapshot.version + 1;
    this.phase = "live";
    this.catchUp();
    this.wake();
  }

  /** @internal Called by the store on every published version. */
  onPublish(): void {
    if (this.phase !== "live") return;
    this.catchUp();
    this.wake();
  }

  private catchUp(): void {
    if (this.nextVersion === null) return;
    const entries = this.store._logFrom(this.nextVersion);
    if (entries === null) {
      // Shared log was trimmed past us: a gap is unavoidable, so resync
      // explicitly instead of skipping versions.
      this.resync();
      return;
    }
    for (const entry of entries) {
      if (this.queue.length >= this.maxBuffer) {
        // Slow consumer overflowed the per-subscription buffer: resync
        // explicitly instead of dropping deltas silently.
        this.resync();
        return;
      }
      this.queue.push({ type: "delta", version: entry.version, delta: entry.delta });
      this.nextVersion = entry.version + 1;
    }
  }

  private resync(): void {
    const snapshot = this.store._currentSnapshot();
    this.queue = [
      { type: "resync", version: snapshot.version, state: snapshot.state },
    ];
    this.nextVersion = snapshot.version + 1;
  }

  /**
   * Terminates the subscription. The returned promise resolves only after
   * any in-flight snapshot promise has settled, guaranteeing that no late
   * snapshot resolution can emit messages or re-register the subscription.
   */
  async close(): Promise<void> {
    this.terminate();
    await this.startPromise.catch(() => undefined);
  }

  private terminate(): void {
    if (this.phase === "closed") return;
    this.phase = "closed";
    this.store._unregister(this);
    this.queue = [];
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Message<T, D>, void, unknown> {
    try {
      for (;;) {
        while (this.queue.length > 0) {
          yield this.queue.shift()!;
        }
        if (this.phase === "closed") return;
        await new Promise<void>((resolve) => {
          this.waiter = resolve;
        });
        this.waiter = null;
      }
    } finally {
      this.terminate();
    }
  }
}
