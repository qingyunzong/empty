export class ConflictError extends Error {
  constructor(message = 'transaction conflict: baseline version changed') {
    super(message);
    this.name = 'ConflictError';
  }
}

export class TransactionClosedError extends Error {
  constructor(message = 'transaction is no longer active') {
    super(message);
    this.name = 'TransactionClosedError';
  }
}

export class Store {
  #data = new Map<string, unknown>();
  #version = 0;

  get version(): number {
    return this.#version;
  }

  get(key: string): unknown {
    return this.#data.get(key);
  }

  set(key: string, value: unknown): void {
    this.#data.set(key, value);
    this.#version += 1;
  }

  async transaction<T>(fn: (tx: Transaction) => T | Promise<T>): Promise<T> {
    const tx = new Transaction(this, this.#version);
    try {
      const result = await fn(tx);
      if (tx.isOpen) {
        await tx.commit();
      }
      return result;
    } catch (err) {
      tx.settleSilently();
      throw err;
    } finally {
      tx.close();
    }
  }

  applyCommit(baseVersion: number, staged: ReadonlyMap<string, unknown>): void {
    if (this.#version !== baseVersion) {
      throw new ConflictError(
        `transaction conflict: baseline version ${baseVersion} != current version ${this.#version}`,
      );
    }
    for (const [key, value] of staged) {
      this.#data.set(key, value);
    }
    this.#version += 1;
  }
}

export class Transaction {
  #store: Store;
  #baseVersion: number;
  #staged = new Map<string, unknown>();
  #settled = false;
  #closed = false;

  constructor(store: Store, baseVersion: number) {
    this.#store = store;
    this.#baseVersion = baseVersion;
  }

  get isOpen(): boolean {
    return !this.#settled && !this.#closed;
  }

  get baseVersion(): number {
    return this.#baseVersion;
  }

  #assertActive(): void {
    if (this.#closed || this.#settled) {
      throw new TransactionClosedError();
    }
  }

  get(key: string): unknown {
    this.#assertActive();
    return this.#staged.has(key) ? this.#staged.get(key) : this.#store.get(key);
  }

  set(key: string, value: unknown): void {
    this.#assertActive();
    this.#staged.set(key, value);
  }

  async commit(): Promise<void> {
    this.#assertActive();
    this.#settled = true;
    this.#store.applyCommit(this.#baseVersion, this.#staged);
  }

  cancel(): void {
    this.#assertActive();
    this.#settled = true;
  }

  settleSilently(): void {
    this.#settled = true;
  }

  close(): void {
    this.#closed = true;
  }
}
