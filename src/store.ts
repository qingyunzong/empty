/**
 * StateStore — an in-memory key/value store with optimistic-concurrency
 * transactions.
 *
 * Semantics:
 * - A transaction callback may be async (awaited by the store).
 * - Writes inside a transaction only record *staged* changes; they are
 *   invisible to readers outside the transaction until commit.
 * - The transaction captures the store's version as its baseline. If the
 *   baseline changes before commit, the whole transaction conflicts and
 *   nothing is applied.
 * - Once the callback returns, the transaction object is closed: any
 *   further read/write through it throws TransactionClosedError.
 * - commit() and cancel() share a single resolution: whichever settles
 *   first wins; any later settle attempt rejects with
 *   TransactionSettledError.
 */

export class ConflictError extends Error {
  override readonly name = "ConflictError";
  constructor(message = "transaction conflict: store version changed since transaction start") {
    super(message);
  }
}

export class TransactionClosedError extends Error {
  override readonly name = "TransactionClosedError";
  constructor(message = "transaction is closed: reads/writes are forbidden after the callback returned") {
    super(message);
  }
}

export class TransactionSettledError extends Error {
  override readonly name = "TransactionSettledError";
  constructor(message = "transaction already settled: commit and cancel allow only one resolution") {
    super(message);
  }
}

type StagedEntry = { kind: "set"; value: unknown } | { kind: "delete" };

export class Transaction {
  readonly #store: StateStore;
  readonly #baseline: number;
  readonly #staged = new Map<string, StagedEntry>();
  #closed = false;
  #settled: "committed" | "cancelled" | null = null;

  constructor(store: StateStore, baseline: number) {
    this.#store = store;
    this.#baseline = baseline;
  }

  get baseline(): number {
    return this.#baseline;
  }

  get settled(): "committed" | "cancelled" | null {
    return this.#settled;
  }

  get closed(): boolean {
    return this.#closed;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new TransactionClosedError();
    }
  }

  /** Reads see this transaction's staged changes first, then the live store. */
  async get(key: string): Promise<unknown> {
    this.#assertOpen();
    const entry = this.#staged.get(key);
    if (entry !== undefined) {
      return entry.kind === "set" ? entry.value : undefined;
    }
    return this.#store.get(key);
  }

  /** Records a staged write; nothing is visible outside until commit. */
  async set(key: string, value: unknown): Promise<void> {
    this.#assertOpen();
    this.#staged.set(key, { kind: "set", value });
  }

  /** Records a staged delete; applied to the store only on commit. */
  async delete(key: string): Promise<void> {
    this.#assertOpen();
    this.#staged.set(key, { kind: "delete" });
  }

  /**
   * Applies all staged changes atomically if the store version still
   * matches the baseline captured at transaction start; otherwise the
   * whole transaction conflicts, staged changes are discarded, and a
   * ConflictError is thrown.
   */
  async commit(): Promise<void> {
    this.#settle("committed");
    if (this.#store.version !== this.#baseline) {
      this.#staged.clear();
      throw new ConflictError();
    }
    this.#store.applyStaged(this.#staged);
    this.#staged.clear();
  }

  /** Discards all staged changes without touching the store. */
  async cancel(): Promise<void> {
    this.#settle("cancelled");
    this.#staged.clear();
  }

  #settle(outcome: "committed" | "cancelled"): void {
    if (this.#settled !== null) {
      throw new TransactionSettledError();
    }
    this.#settled = outcome;
  }

  /** Called by the store when the transaction callback has returned. */
  close(): void {
    this.#closed = true;
  }

  /** Called by the store to discard staged changes without settling. */
  discardIfUnsettled(): void {
    if (this.#settled === null) {
      this.#staged.clear();
      this.#settled = "cancelled";
    }
  }
}

export class StateStore {
  #data = new Map<string, unknown>();
  #version = 0;

  /** Monotonic version; bumped once per direct write and once per commit. */
  get version(): number {
    return this.#version;
  }

  async get(key: string): Promise<unknown> {
    return this.#data.get(key);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.#data.set(key, value);
    this.#version += 1;
  }

  async delete(key: string): Promise<void> {
    if (this.#data.delete(key)) {
      this.#version += 1;
    }
  }

  /**
   * Runs `fn` inside a transaction. The callback may be async and is
   * awaited. When it returns, the transaction object is closed; if the
   * callback did not settle the transaction itself, the store commits it
   * automatically (which may throw ConflictError). If the callback throws,
   * staged changes are discarded and the error is rethrown.
   */
  async transaction<T>(fn: (tx: Transaction) => T | Promise<T>): Promise<T> {
    const tx = new Transaction(this, this.#version);
    let result: T;
    try {
      result = await fn(tx);
    } catch (err) {
      tx.close();
      tx.discardIfUnsettled();
      throw err;
    }
    tx.close();
    if (tx.settled === null) {
      await tx.commit();
    }
    return result;
  }

  /** Internal: applies staged entries atomically as a single version bump. */
  applyStaged(staged: Map<string, StagedEntry>): void {
    if (staged.size === 0) {
      return;
    }
    for (const [key, entry] of staged) {
      if (entry.kind === "set") {
        this.#data.set(key, entry.value);
      } else {
        this.#data.delete(key);
      }
    }
    this.#version += 1;
  }
}
