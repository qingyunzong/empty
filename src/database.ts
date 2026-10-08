/**
 * Transactional in-memory database with per-field indexes.
 *
 * Semantics:
 * - Indexes map field values to row ids (unique and non-unique).
 * - A transaction that touches the same row many times publishes only the
 *   final net change (committed-before -> final-after).
 * - Unique constraints are validated at commit time against the batch's final
 *   state, so two rows may swap unique keys inside one transaction.
 * - Any failure (exception or constraint violation) rolls back everything;
 *   the committed state is never partially mutated.
 * - Subscribers run after the commit has been fully applied and may reenter
 *   the database (e.g. start new transactions).
 */

export type RowId = number;
export type Row = Record<string, unknown>;

export interface Change {
  readonly type: "insert" | "update" | "delete";
  readonly id: RowId;
  /** Committed row image before the transaction (undefined for inserts). */
  readonly before?: Row;
  /** Final row image after the transaction (undefined for deletes). */
  readonly after?: Row;
}

export type Subscriber = (changes: readonly Change[], db: Database) => void;

export class UniqueConstraintError extends Error {
  constructor(
    public readonly table: string,
    public readonly field: string,
    public readonly value: unknown,
  ) {
    super(
      `unique constraint violation on ${table}.${field} for value ${JSON.stringify(value)}`,
    );
    this.name = "UniqueConstraintError";
  }
}

interface StagedRow {
  /** Committed image captured lazily on first touch (undefined = did not exist). */
  before?: Row;
  /** Latest staged image (undefined = deleted / never inserted). */
  after?: Row;
}

export interface TableSchema {
  readonly name: string;
  /** Non-unique indexed fields: value -> set of row ids. */
  readonly indexedFields?: readonly string[];
  /** Unique indexed fields: value -> single row id. */
  readonly uniqueFields?: readonly string[];
}

class Table {
  readonly rows = new Map<RowId, Row>();
  readonly indexes = new Map<string, Map<unknown, Set<RowId>>>();
  readonly uniqueIndexes = new Map<string, Map<unknown, RowId>>();
  nextId: RowId = 1;

  constructor(readonly schema: TableSchema) {
    for (const field of schema.indexedFields ?? []) {
      if ((schema.uniqueFields ?? []).includes(field)) {
        throw new Error(`field ${schema.name}.${field} declared both indexed and unique`);
      }
      this.indexes.set(field, new Map());
    }
    for (const field of schema.uniqueFields ?? []) {
      this.uniqueIndexes.set(field, new Map());
    }
  }

  get indexedFields(): string[] {
    return [...this.indexes.keys()];
  }

  get uniqueFields(): string[] {
    return [...this.uniqueIndexes.keys()];
  }
}

interface CommitResult {
  readonly table: string;
  readonly changes: Change[];
}

export class Database {
  private readonly tables = new Map<string, Table>();
  private readonly subscribers = new Map<string, Subscriber[]>();
  private activeTx: Transaction | null = null;

  createTable(schema: TableSchema): void {
    if (this.tables.has(schema.name)) {
      throw new Error(`table ${schema.name} already exists`);
    }
    this.tables.set(schema.name, new Table(schema));
  }

  subscribe(table: string, subscriber: Subscriber): () => void {
    this.table(table); // ensure the table exists
    const list = this.subscribers.get(table) ?? [];
    list.push(subscriber);
    this.subscribers.set(table, list);
    return () => {
      const current = this.subscribers.get(table);
      if (!current) return;
      const index = current.indexOf(subscriber);
      if (index >= 0) current.splice(index, 1);
    };
  }

  /**
   * Runs `fn` inside a transaction. Staged writes are validated and applied
   * atomically when `fn` returns; any throw discards all staged writes.
   * Subscribers are notified after the commit with coalesced changes.
   */
  transaction<T>(fn: (tx: Transaction) => T): T {
    if (this.activeTx) {
      throw new Error("nested transactions are not supported; open a new transaction after commit");
    }
    const tx = new Transaction(this);
    this.activeTx = tx;
    let result: T;
    try {
      result = fn(tx);
    } finally {
      this.activeTx = null;
    }
    this.commit(tx);
    return result;
  }

  /** Committed-state read. */
  get(table: string, id: RowId): Row | undefined {
    const row = this.table(table).rows.get(id);
    return row ? { ...row } : undefined;
  }

  /** Committed-state index lookup: field value -> rows. */
  query(table: string, field: string, value: unknown): Row[] {
    return this.idsFor(this.table(table), field, value).map(
      (id) => ({ ...this.table(table).rows.get(id)! }),
    );
  }

  all(table: string): Row[] {
    return [...this.table(table).rows.values()].map((row) => ({ ...row }));
  }

  /**
   * Serializable snapshot of every index, for verification against a model.
   * Non-unique: field -> [[value, sortedIds]]. Unique: field -> [[value, id]].
   */
  indexSnapshot(table: string): {
    indexes: Record<string, [unknown, RowId[]][]>;
    uniqueIndexes: Record<string, [unknown, RowId][]>;
  } {
    const t = this.table(table);
    const sortEntries = <V>(map: Map<unknown, V>): [unknown, V][] =>
      [...map.entries()].sort((a, b) => compareKeys(a[0], b[0]));
    const indexes: Record<string, [unknown, RowId[]][]> = {};
    for (const [field, map] of t.indexes) {
      indexes[field] = sortEntries(map).map(([value, ids]) => [
        value,
        [...ids].sort((a, b) => a - b),
      ]);
    }
    const uniqueIndexes: Record<string, [unknown, RowId][]> = {};
    for (const [field, map] of t.uniqueIndexes) {
      uniqueIndexes[field] = sortEntries(map);
    }
    return { indexes, uniqueIndexes };
  }

  private idsFor(table: Table, field: string, value: unknown): RowId[] {
    const unique = table.uniqueIndexes.get(field);
    if (unique) {
      const id = unique.get(value);
      return id === undefined ? [] : [id];
    }
    const index = table.indexes.get(field);
    if (!index) {
      throw new Error(`no index on ${table.schema.name}.${field}`);
    }
    return [...index.get(value) ?? []];
  }

  private commit(tx: Transaction): void {
    const staged = tx.drain();
    if (staged.size === 0) return;

    // Phase 1: validate unique constraints against the batch's final state.
    // Removals are conceptually applied before additions, which is what
    // allows two rows to swap unique keys within one transaction.
    for (const [tableName, rows] of staged) {
      const table = this.table(tableName);
      for (const field of table.uniqueFields) {
        const index = table.uniqueIndexes.get(field)!;
        const claimed = new Map<unknown, RowId>();
        for (const [id, change] of rows) {
          if (change.after === undefined) continue;
          const value = change.after[field];
          const existingClaim = claimed.get(value);
          if (existingClaim !== undefined && existingClaim !== id) {
            throw new UniqueConstraintError(tableName, field, value);
          }
          claimed.set(value, id);
          const owner = index.get(value);
          if (owner !== undefined && owner !== id) {
            const ownerChange = rows.get(owner);
            const ownerMovesAway =
              ownerChange !== undefined &&
              (ownerChange.after === undefined || ownerChange.after[field] !== value);
            if (!ownerMovesAway) {
              throw new UniqueConstraintError(tableName, field, value);
            }
          }
        }
      }
    }

    // Phase 2: apply. Validation is complete, so this cannot fail.
    const results: CommitResult[] = [];
    for (const [tableName, rows] of staged) {
      const table = this.table(tableName);
      const changes: Change[] = [];
      for (const [id, change] of rows) {
        const { before, after } = change;
        if (before === undefined && after === undefined) continue;
        if (before !== undefined && after !== undefined && shallowEqual(before, after)) {
          continue; // touched but net-zero
        }
        if (before !== undefined) removeFromIndexes(table, id, before);
        if (after !== undefined) addToIndexes(table, id, after);
        if (after === undefined) table.rows.delete(id);
        else table.rows.set(id, { ...after });
        changes.push({
          type: before === undefined ? "insert" : after === undefined ? "delete" : "update",
          id,
          before: before ? { ...before } : undefined,
          after: after ? { ...after } : undefined,
        });
      }
      if (changes.length > 0) results.push({ table: tableName, changes });
    }

    // Phase 3: publish after the commit is fully applied. Subscribers may
    // reenter the database, including starting (and committing) new
    // transactions; their notifications nest inside this loop safely.
    for (const { table, changes } of results) {
      const list = this.subscribers.get(table);
      if (!list) continue;
      for (const subscriber of [...list]) {
        subscriber(changes, this);
      }
    }
  }

  private table(name: string): Table {
    const table = this.tables.get(name);
    if (!table) throw new Error(`unknown table ${name}`);
    return table;
  }

  /** Internal accessors used by Transaction. */
  tableFor(name: string): {
    rows: Map<RowId, Row>;
    nextId: RowId;
    allocateId(): RowId;
    indexedFields: string[];
    uniqueFields: string[];
    committedIdsFor(field: string, value: unknown): RowId[];
  } {
    const table = this.table(name);
    return {
      rows: table.rows,
      get nextId() {
        return table.nextId;
      },
      allocateId: () => table.nextId++,
      indexedFields: table.indexedFields,
      uniqueFields: table.uniqueFields,
      committedIdsFor: (field, value) => this.idsFor(table, field, value),
    };
  }
}

export class Transaction {
  private readonly staged = new Map<string, Map<RowId, StagedRow>>();
  private closed = false;

  constructor(private readonly db: Database) {}

  insert(table: string, row: Row): RowId {
    this.ensureOpen();
    const handle = this.db.tableFor(table);
    const id = handle.allocateId();
    this.stagedRows(table).set(id, { before: undefined, after: { ...row } });
    return id;
  }

  update(table: string, id: RowId, patch: Partial<Row>): void {
    this.ensureOpen();
    const current = this.read(table, id);
    if (current === undefined) {
      throw new Error(`cannot update missing row ${table}#${id}`);
    }
    this.stage(table, id).after = { ...current, ...patch };
  }

  delete(table: string, id: RowId): void {
    this.ensureOpen();
    const staged = this.stagedRows(table).get(id);
    if (staged) {
      staged.after = undefined;
      return;
    }
    const handle = this.db.tableFor(table);
    const committed = handle.rows.get(id);
    if (committed === undefined) {
      throw new Error(`cannot delete missing row ${table}#${id}`);
    }
    this.stagedRows(table).set(id, { before: committed, after: undefined });
  }

  /** Read-your-writes lookup by id. */
  get(table: string, id: RowId): Row | undefined {
    this.ensureOpen();
    const row = this.read(table, id);
    return row ? { ...row } : undefined;
  }

  /** Read-your-writes index lookup. */
  query(table: string, field: string, value: unknown): Row[] {
    this.ensureOpen();
    const handle = this.db.tableFor(table);
    const ids = new Set(handle.committedIdsFor(field, value));
    for (const [id, change] of this.stagedRows(table)) {
      const beforeMatch = change.before !== undefined && change.before[field] === value;
      const afterMatch = change.after !== undefined && change.after[field] === value;
      if (beforeMatch && !afterMatch) ids.delete(id);
      if (afterMatch) ids.add(id);
    }
    return [...ids]
      .sort((a, b) => a - b)
      .map((id) => this.read(table, id))
      .filter((row): row is Row => row !== undefined)
      .map((row) => ({ ...row }));
  }

  /** Consumed by Database.commit. */
  drain(): Map<string, Map<RowId, StagedRow>> {
    this.closed = true;
    return this.staged;
  }

  private read(table: string, id: RowId): Row | undefined {
    const staged = this.stagedRows(table).get(id);
    if (staged) return staged.after;
    return this.db.tableFor(table).rows.get(id);
  }

  private stage(table: string, id: RowId): StagedRow {
    const rows = this.stagedRows(table);
    let staged = rows.get(id);
    if (!staged) {
      staged = { before: this.db.tableFor(table).rows.get(id), after: undefined };
      staged.after = staged.before ? { ...staged.before } : undefined;
      rows.set(id, staged);
    }
    return staged;
  }

  private stagedRows(table: string): Map<RowId, StagedRow> {
    let rows = this.staged.get(table);
    if (!rows) {
      rows = new Map();
      this.staged.set(table, rows);
    }
    return rows;
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("transaction already committed");
  }
}

function addToIndexes(table: Table, id: RowId, row: Row): void {
  for (const [field, index] of table.indexes) {
    const value = row[field];
    let ids = index.get(value);
    if (!ids) {
      ids = new Set();
      index.set(value, ids);
    }
    ids.add(id);
  }
  for (const [field, index] of table.uniqueIndexes) {
    index.set(row[field], id);
  }
}

function removeFromIndexes(table: Table, id: RowId, row: Row): void {
  for (const [field, index] of table.indexes) {
    const ids = index.get(row[field]);
    if (!ids) continue;
    ids.delete(id);
    if (ids.size === 0) index.delete(row[field]);
  }
  for (const [field, index] of table.uniqueIndexes) {
    if (index.get(row[field]) === id) index.delete(row[field]);
  }
}

function shallowEqual(a: Row, b: Row): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

function compareKeys(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}
