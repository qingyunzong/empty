/**
 * Transactional indexed row store.
 *
 * - Secondary indexes map field values to row ids (unique and multi).
 * - Transactions stage mutations; rows touched many times publish only the
 *   final coalesced delta on commit.
 * - Unique constraints are validated against the merged end-of-batch view, so
 *   two rows may swap keys inside one transaction. Any failure rolls the whole
 *   transaction back: base state and indexes are never touched before commit.
 * - Subscribers run after the commit is fully applied and may re-enter
 *   (start nested transactions) safely.
 */

export type RowId = number;
export type Row = Record<string, unknown>;

export interface IndexSpec {
  name: string;
  field: string;
  unique?: boolean;
}

export type ChangeType = 'insert' | 'update' | 'delete';

export interface RowChange {
  type: ChangeType;
  id: RowId;
  before: Row | null;
  after: Row | null;
  changedFields: string[];
}

export type Delta = RowChange[];

export type Subscriber = (delta: Delta, table: Table) => void;

export class UniqueConstraintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UniqueConstraintError';
  }
}

export class UnknownIndexError extends Error {
  constructor(name: string) {
    super(`unknown index "${name}"`);
    this.name = 'UnknownIndexError';
  }
}

interface PendingEntry {
  before: Row | null;
  after: Row | null;
}

function rowsEqual(a: Row, b: Row): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}

export class Table {
  readonly name: string;

  private readonly rows = new Map<RowId, Row>();
  private readonly indexField = new Map<string, string>();
  private readonly indexUnique = new Map<string, boolean>();
  private readonly uniqueIndexes = new Map<string, Map<unknown, RowId>>();
  private readonly multiIndexes = new Map<string, Map<unknown, Set<RowId>>>();
  private readonly subscribers = new Set<Subscriber>();
  private nextRowId: RowId = 1;

  constructor(name: string, indexes: IndexSpec[] = []) {
    this.name = name;
    for (const spec of indexes) {
      if (this.indexField.has(spec.name)) {
        throw new Error(`duplicate index "${spec.name}"`);
      }
      this.indexField.set(spec.name, spec.field);
      this.indexUnique.set(spec.name, spec.unique === true);
      if (spec.unique === true) {
        this.uniqueIndexes.set(spec.name, new Map());
      } else {
        this.multiIndexes.set(spec.name, new Map());
      }
    }
  }

  get size(): number {
    return this.rows.size;
  }

  has(id: RowId): boolean {
    return this.rows.has(id);
  }

  get(id: RowId): Row | undefined {
    const row = this.rows.get(id);
    return row === undefined ? undefined : { ...row };
  }

  entries(): Array<[RowId, Row]> {
    return [...this.rows.entries()].map(([id, row]) => [id, { ...row }]);
  }

  indexNames(): string[] {
    return [...this.indexField.keys()];
  }

  indexFieldOf(name: string): string {
    const field = this.indexField.get(name);
    if (field === undefined) throw new UnknownIndexError(name);
    return field;
  }

  isUniqueIndex(name: string): boolean {
    if (!this.indexUnique.has(name)) throw new UnknownIndexError(name);
    return this.indexUnique.get(name) as boolean;
  }

  /** Look up row ids by indexed field value. */
  findBy(indexName: string, key: unknown): RowId[] {
    if (this.isUniqueIndex(indexName)) {
      const id = (this.uniqueIndexes.get(indexName) as Map<unknown, RowId>).get(key);
      return id === undefined ? [] : [id];
    }
    const ids = (this.multiIndexes.get(indexName) as Map<unknown, Set<RowId>>).get(key);
    return ids === undefined ? [] : [...ids];
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /**
   * Run `fn` against a staged transaction. If `fn` throws or commit-time
   * validation fails, nothing is applied and the error propagates.
   * Returns the published delta (empty when nothing effectively changed).
   */
  transaction(fn: (tx: Transaction) => void): Delta {
    const tx = new Transaction(this);
    fn(tx);
    return this.commit(tx);
  }

  /** @internal Allocate a fresh row id. */
  allocateId(): RowId {
    return this.nextRowId++;
  }

  /** @internal Keep auto ids ahead of explicitly supplied ids. */
  reserveId(id: RowId): void {
    if (id >= this.nextRowId) this.nextRowId = id + 1;
  }

  /** @internal Raw (shared) row reference for transactional staging. */
  rawGet(id: RowId): Row | undefined {
    return this.rows.get(id);
  }

  private commit(tx: Transaction): Delta {
    const pending = tx.pendingEntries();

    // 1. Validate unique constraints against the merged end-of-batch view.
    //    Because validation sees only final row states, key swaps inside one
    //    batch are allowed; any violation aborts before any state is touched.
    for (const [name, index] of this.uniqueIndexes) {
      const field = this.indexField.get(name) as string;
      const seen = new Map<unknown, RowId>();
      for (const [id, entry] of pending) {
        if (entry.after === null) continue;
        const key = entry.after[field];
        if (key === undefined) continue;
        const other = seen.get(key);
        if (other !== undefined) {
          throw new UniqueConstraintError(
            `index "${name}": duplicate key ${JSON.stringify(key)} for rows ${other} and ${id}`,
          );
        }
        seen.set(key, id);
        const owner = index.get(key);
        if (owner !== undefined && owner !== id && !pending.has(owner)) {
          throw new UniqueConstraintError(
            `index "${name}": key ${JSON.stringify(key)} already held by row ${owner}`,
          );
        }
      }
    }

    // 2. Coalesce staged mutations into the final per-row delta.
    const delta: Delta = [];
    for (const [id, entry] of pending) {
      const { before, after } = entry;
      if (before === null && after === null) continue; // inserted then deleted
      if (before !== null && after !== null && rowsEqual(before, after)) continue;
      const changedFields: string[] = [];
      if (before !== null && after !== null) {
        const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
        for (const key of keys) {
          if (!Object.is(before[key], after[key])) changedFields.push(key);
        }
      }
      const type: ChangeType =
        before === null ? 'insert' : after === null ? 'delete' : 'update';
      delta.push({
        type,
        id,
        before: before === null ? null : { ...before },
        after: after === null ? null : { ...after },
        changedFields,
      });
    }

    // 3. Apply to base rows and every index. Validation already passed, so
    //    this phase cannot fail.
    for (const change of delta) {
      this.applyChange(change);
    }

    // 4. Notify after the commit is fully visible. Subscribers may re-enter
    //    and start new transactions; nested commits notify nested subscribers
    //    before the outer notification loop continues.
    if (delta.length > 0) {
      for (const subscriber of [...this.subscribers]) {
        subscriber(delta, this);
      }
    }
    return delta;
  }

  private applyChange(change: RowChange): void {
    if (change.after === null) {
      this.rows.delete(change.id);
    } else {
      this.rows.set(change.id, { ...change.after });
    }
    for (const [name, field] of this.indexField) {
      const beforeKey = change.before === null ? undefined : change.before[field];
      const afterKey = change.after === null ? undefined : change.after[field];
      if (Object.is(beforeKey, afterKey)) continue;
      if (this.indexUnique.get(name) === true) {
        const index = this.uniqueIndexes.get(name) as Map<unknown, RowId>;
        // Only remove the old mapping if it still points at this row: during
        // an in-batch key swap another change may already have claimed the key.
        if (beforeKey !== undefined && index.get(beforeKey) === change.id) {
          index.delete(beforeKey);
        }
        if (afterKey !== undefined) index.set(afterKey, change.id);
      } else {
        const index = this.multiIndexes.get(name) as Map<unknown, Set<RowId>>;
        if (beforeKey !== undefined) {
          const ids = index.get(beforeKey);
          if (ids !== undefined) {
            ids.delete(change.id);
            if (ids.size === 0) index.delete(beforeKey);
          }
        }
        if (afterKey !== undefined) {
          let ids = index.get(afterKey);
          if (ids === undefined) {
            ids = new Set();
            index.set(afterKey, ids);
          }
          ids.add(change.id);
        }
      }
    }
  }

  /** @internal Snapshot of the live index structures (for verification). */
  liveIndexModel(): IndexModel {
    const unique = new Map<string, Map<unknown, RowId>>();
    for (const [name, index] of this.uniqueIndexes) {
      unique.set(name, new Map(index));
    }
    const multi = new Map<string, Map<unknown, Set<RowId>>>();
    for (const [name, index] of this.multiIndexes) {
      multi.set(
        name,
        new Map([...index.entries()].map(([key, ids]) => [key, new Set(ids)])),
      );
    }
    return { unique, multi };
  }

  /** @internal Rebuild the full index model from row data alone. */
  rebuildIndexModel(): IndexModel {
    const unique = new Map<string, Map<unknown, RowId>>();
    const multi = new Map<string, Map<unknown, Set<RowId>>>();
    for (const name of this.uniqueIndexes.keys()) unique.set(name, new Map());
    for (const name of this.multiIndexes.keys()) multi.set(name, new Map());
    for (const [id, row] of this.rows) {
      for (const [name, field] of this.indexField) {
        const key = row[field];
        if (key === undefined) continue;
        if (this.indexUnique.get(name) === true) {
          (unique.get(name) as Map<unknown, RowId>).set(key, id);
        } else {
          const index = multi.get(name) as Map<unknown, Set<RowId>>;
          let ids = index.get(key);
          if (ids === undefined) {
            ids = new Set();
            index.set(key, ids);
          }
          ids.add(id);
        }
      }
    }
    return { unique, multi };
  }

  /** @internal Snapshot of all rows (for verification). */
  rowSnapshot(): Map<RowId, Row> {
    return new Map([...this.rows.entries()].map(([id, row]) => [id, { ...row }]));
  }
}

export interface IndexModel {
  unique: Map<string, Map<unknown, RowId>>;
  multi: Map<string, Map<unknown, Set<RowId>>>;
}

export class Transaction {
  private readonly pending = new Map<RowId, PendingEntry>();

  /** @internal */
  constructor(private readonly table: Table) {}

  private entry(id: RowId): PendingEntry {
    let entry = this.pending.get(id);
    if (entry === undefined) {
      const current = this.table.rawGet(id);
      entry = {
        before: current === undefined ? null : { ...current },
        after: current === undefined ? null : { ...current },
      };
      this.pending.set(id, entry);
    }
    return entry;
  }

  /** Insert a row; returns its id. Pass `id` to preserve identity (replication). */
  insert(row: Row, id?: RowId): RowId {
    const assigned = id ?? this.table.allocateId();
    if (id !== undefined) this.table.reserveId(id);
    const entry = this.entry(assigned);
    if (entry.after !== null) {
      throw new Error(`row ${assigned} already exists`);
    }
    entry.after = { ...row };
    return assigned;
  }

  /** Merge `patch` into the staged row state. */
  update(id: RowId, patch: Row): void {
    const entry = this.entry(id);
    if (entry.after === null) {
      throw new Error(`row ${id} does not exist`);
    }
    entry.after = { ...entry.after, ...patch };
  }

  /** Replace the staged row state wholesale. */
  replace(id: RowId, row: Row): void {
    const entry = this.entry(id);
    if (entry.after === null) {
      throw new Error(`row ${id} does not exist`);
    }
    entry.after = { ...row };
  }

  delete(id: RowId): void {
    const entry = this.entry(id);
    if (entry.after === null) {
      throw new Error(`row ${id} does not exist`);
    }
    entry.after = null;
  }

  /** Read-your-writes view inside the transaction. */
  get(id: RowId): Row | undefined {
    const entry = this.pending.get(id);
    const row = entry !== undefined ? entry.after : (this.table.rawGet(id) ?? null);
    return row === null || row === undefined ? undefined : { ...row };
  }

  /** @internal */
  pendingEntries(): Map<RowId, PendingEntry> {
    return this.pending;
  }
}
