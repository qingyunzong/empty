export type ConfigEntries = Record<string, unknown>;

export interface ConfigChange {
  key: string;
  value?: unknown;
  deleted?: boolean;
}

export type ServerMessage =
  | { type: "snapshot"; revision: number; entries: ConfigEntries }
  | { type: "delta"; revision: number; changes: ConfigChange[] }
  | { type: "compacted"; revision: number };

export interface SubscribeRequest {
  /** null means "from scratch": the server answers with a full snapshot. */
  fromRevision: number | null;
}

export interface Connection {
  send(request: SubscribeRequest): void;
  close(): void;
}

export interface ConnectionSink {
  onMessage(message: ServerMessage): void;
  onClose(reason?: unknown): void;
}

export type ConnectFn = (sink: ConnectionSink) => Connection;

export interface ConfigView {
  revision: number;
  entries: ConfigEntries;
}

export type ConfigListener = (view: ConfigView) => void;

export interface ConfigWatcherOptions {
  connect: ConnectFn;
  /** Deltas ahead of the watermark are buffered; beyond this limit a resync is forced. */
  maxBufferedDeltas?: number;
  /** Injectable reconnect scheduler (defaults to a 1s setTimeout). */
  scheduleReconnect?: (reconnect: () => void) => void;
}

const DEFAULT_MAX_BUFFERED_DELTAS = 1024;

export class ConfigWatcher {
  readonly #connect: ConnectFn;
  readonly #maxBufferedDeltas: number;
  readonly #scheduleReconnect: (reconnect: () => void) => void;

  #conn: Connection | null = null;
  #revision = 0;
  #entries: ConfigEntries = {};
  readonly #pending = new Map<number, ConfigChange[]>();
  readonly #listeners = new Set<ConfigListener>();
  #started = false;

  constructor(options: ConfigWatcherOptions) {
    this.#connect = options.connect;
    this.#maxBufferedDeltas =
      options.maxBufferedDeltas ?? DEFAULT_MAX_BUFFERED_DELTAS;
    this.#scheduleReconnect =
      options.scheduleReconnect ??
      ((reconnect) => setTimeout(reconnect, 1000));
  }

  get revision(): number {
    return this.#revision;
  }

  get(key: string): unknown {
    return this.#entries[key];
  }

  getAll(): ConfigEntries {
    return { ...this.#entries };
  }

  subscribe(listener: ConfigListener): () => void {
    this.#listeners.add(listener);
    if (this.#revision > 0) {
      listener(this.#view());
    }
    return () => {
      this.#listeners.delete(listener);
    };
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#open();
  }

  stop(): void {
    this.#started = false;
    const conn = this.#conn;
    this.#conn = null;
    conn?.close();
  }

  #open(): void {
    let conn: Connection;
    const sink: ConnectionSink = {
      onMessage: (message) => {
        // Late events from a superseded connection are dropped here.
        if (conn === this.#conn) this.#onMessage(message);
      },
      onClose: () => {
        if (conn !== this.#conn) return;
        this.#conn = null;
        if (this.#started) {
          this.#scheduleReconnect(() => {
            if (this.#started && this.#conn === null) this.#open();
          });
        }
      },
    };
    conn = this.#connect(sink);
    this.#conn = conn;
    // Resume from the acknowledged watermark; null requests a full snapshot.
    conn.send({ fromRevision: this.#revision === 0 ? null : this.#revision });
  }

  #reopen(): void {
    const old = this.#conn;
    this.#conn = null;
    old?.close();
    if (this.#started) this.#open();
  }

  #onMessage(message: ServerMessage): void {
    switch (message.type) {
      case "snapshot":
        this.#onSnapshot(message.revision, message.entries);
        break;
      case "delta":
        this.#onDelta(message.revision, message.changes);
        break;
      case "compacted":
        this.#onCompacted();
        break;
    }
  }

  #onSnapshot(revision: number, entries: ConfigEntries): void {
    if (revision < this.#revision) return; // stale snapshot, keep newer state
    this.#entries = { ...entries };
    this.#revision = revision;
    for (const rev of [...this.#pending.keys()]) {
      if (rev <= revision) this.#pending.delete(rev);
    }
    this.#emit();
    this.#drain();
  }

  #onDelta(revision: number, changes: ConfigChange[]): void {
    if (revision <= this.#revision) return; // duplicate or late delta
    this.#pending.set(revision, changes);
    if (this.#pending.size > this.#maxBufferedDeltas) {
      // Gap too large: resync from the watermark instead of buffering forever.
      this.#pending.clear();
      this.#reopen();
      return;
    }
    this.#drain();
  }

  #onCompacted(): void {
    // The requested watermark was compacted away: rebuild from scratch.
    this.#entries = {};
    this.#revision = 0;
    this.#pending.clear();
    this.#reopen();
  }

  #drain(): void {
    for (;;) {
      const changes = this.#pending.get(this.#revision + 1);
      if (!changes) return;
      this.#pending.delete(this.#revision + 1);
      for (const change of changes) {
        if (change.deleted) {
          delete this.#entries[change.key];
        } else {
          this.#entries[change.key] = change.value;
        }
      }
      this.#revision += 1;
      this.#emit();
    }
  }

  #view(): ConfigView {
    return { revision: this.#revision, entries: { ...this.#entries } };
  }

  #emit(): void {
    const view = this.#view();
    for (const listener of this.#listeners) {
      listener(view);
    }
  }
}
