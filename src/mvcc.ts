/**
 * MVCC relational store with snapshot-isolation (SI) transactions.
 *
 * Semantics implemented here:
 * - A transaction reads from a consistent snapshot taken at `startTs`,
 *   spanning every table in the database (one global timestamp oracle).
 * - Writes are staged in a private buffer; a transaction always reads its
 *   own staged writes (read-your-own-writes), and staged writes are never
 *   visible to other transactions (no dirty reads).
 * - Commit validation checks ONLY the write set (first-committer-wins):
 *   if any key the transaction wrote has a committed version with
 *   commitTs > startTs, the commit aborts with `CommitConflictError`.
 *   Read sets are never validated, therefore write skew is possible.
 */

export type Key = string;
export type Value = string;

/** A single committed version. `value === null` is a tombstone (delete). */
export interface Version {
  readonly value: Value | null;
  readonly commitTs: number;
}

/** Evidence that a write-set key lost the first-committer-wins race. */
export interface ConflictEvidence {
  readonly table: string;
  readonly key: Key;
  /** Snapshot timestamp of the aborted transaction. */
  readonly txnStartTs: number;
  /** commitTs of the already-committed version that won the race. */
  readonly conflictingCommitTs: number;
  /** commitTs that had been allocated to the aborted transaction. */
  readonly attemptedCommitTs: number;
}

export class CommitConflictError extends Error {
  readonly conflicts: readonly ConflictEvidence[];
  constructor(conflicts: ConflictEvidence[]) {
    const desc = conflicts
      .map(
        (c) =>
          `${c.table}/${c.key}: committed@${c.conflictingCommitTs} > snapshot@${c.txnStartTs}`,
      )
      .join("; ");
    super(`commit conflict (first-committer-wins): ${desc}`);
    this.name = "CommitConflictError";
    this.conflicts = conflicts;
  }
}

/** One entry of the database-wide commit log (the "commit barrier" history). */
export interface CommitRecord {
  readonly commitTs: number;
  readonly startTs: number;
  readonly writes: ReadonlyArray<{
    readonly table: string;
    readonly key: Key;
    readonly value: Value | null;
  }>;
}

class Table {
  /** key -> versions, ascending commitTs (commits are serialized). */
  private readonly data = new Map<Key, Version[]>();

  constructor(readonly name: string) {}

  /** Latest committed version of `key` visible at `snapshotTs`. */
  visibleAt(key: Key, snapshotTs: number): Version | undefined {
    const chain = this.data.get(key);
    if (chain === undefined) return undefined;
    for (let i = chain.length - 1; i >= 0; i--) {
      const v = chain[i]!;
      if (v.commitTs <= snapshotTs) return v;
    }
    return undefined;
  }

  /** Newest committed version regardless of snapshot (used by validation). */
  head(key: Key): Version | undefined {
    const chain = this.data.get(key);
    return chain === undefined ? undefined : chain[chain.length - 1];
  }

  appendVersion(key: Key, version: Version): void {
    let chain = this.data.get(key);
    if (chain === undefined) {
      chain = [];
      this.data.set(key, chain);
    }
    chain.push(version);
  }

  /** All keys that have any committed version. */
  keys(): Key[] {
    return [...this.data.keys()];
  }

  /** Full version history of a key, ascending commitTs. */
  history(key: Key): readonly Version[] {
    return this.data.get(key) ?? [];
  }
}

type TxnState = "active" | "committed" | "aborted";

export class Transaction {
  readonly startTs: number;
  private state: TxnState = "active";
  /** table -> key -> staged value (null = staged delete). */
  private readonly staged = new Map<string, Map<Key, Value | null>>();

  constructor(
    private readonly db: Database,
    startTs: number,
  ) {
    this.startTs = startTs;
  }

  get isActive(): boolean {
    return this.state === "active";
  }

  /** Read `key`: own staged writes first, then the snapshot. */
  get(table: string, key: Key): Value | undefined {
    this.assertActive();
    const mine = this.staged.get(table)?.get(key);
    if (mine !== undefined) return mine === null ? undefined : mine;
    if (this.staged.get(table)?.has(key)) return undefined; // staged delete
    const version = this.db.table(table).visibleAt(key, this.startTs);
    if (version === undefined || version.value === null) return undefined;
    return version.value;
  }

  /** Stage a write; only published (atomically, across tables) at commit. */
  set(table: string, key: Key, value: Value): void {
    this.assertActive();
    this.db.table(table); // ensure table exists
    this.bucket(table).set(key, value);
  }

  /** Stage a delete (tombstone). */
  delete(table: string, key: Key): void {
    this.assertActive();
    this.db.table(table);
    this.bucket(table).set(key, null);
  }

  /**
   * Consistent snapshot scan of one table: every (key, value) visible at
   * startTs, overlaid with this transaction's staged writes.
   */
  scan(table: string): Array<[Key, Value]> {
    this.assertActive();
    const t = this.db.table(table);
    const out = new Map<Key, Value>();
    for (const key of t.keys()) {
      const version = t.visibleAt(key, this.startTs);
      if (version !== undefined && version.value !== null) {
        out.set(key, version.value);
      }
    }
    for (const [key, value] of this.staged.get(table) ?? []) {
      if (value === null) out.delete(key);
      else out.set(key, value);
    }
    return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /**
   * Validate the write set (first-committer-wins) and publish all staged
   * writes atomically under one new commitTs. Read sets are NOT checked.
   */
  commit(): CommitRecord {
    this.assertActive();
    const commitTs = this.db.allocateCommitTs();
    const conflicts: ConflictEvidence[] = [];
    for (const [tableName, bucket] of this.staged) {
      const table = this.db.table(tableName);
      for (const key of bucket.keys()) {
        const head = table.head(key);
        if (head !== undefined && head.commitTs > this.startTs) {
          conflicts.push({
            table: tableName,
            key,
            txnStartTs: this.startTs,
            conflictingCommitTs: head.commitTs,
            attemptedCommitTs: commitTs,
          });
        }
      }
    }
    if (conflicts.length > 0) {
      this.state = "aborted";
      throw new CommitConflictError(conflicts);
    }
    const record = this.db.applyCommit(this, commitTs);
    this.state = "committed";
    return record;
  }

  rollback(): void {
    this.assertActive();
    this.state = "aborted";
  }

  /** Internal: staged writes, only called by Database.applyCommit. */
  stagedWrites(): ReadonlyMap<string, ReadonlyMap<Key, Value | null>> {
    return this.staged;
  }

  private bucket(table: string): Map<Key, Value | null> {
    let b = this.staged.get(table);
    if (b === undefined) {
      b = new Map();
      this.staged.set(table, b);
    }
    return b;
  }

  private assertActive(): void {
    if (this.state !== "active") {
      throw new Error(`transaction is ${this.state}`);
    }
  }
}

export class Database {
  private readonly tables = new Map<string, Table>();
  private lastCommitTs = 0;
  private readonly log: CommitRecord[] = [];

  createTable(name: string): void {
    if (this.tables.has(name)) throw new Error(`table exists: ${name}`);
    this.tables.set(name, new Table(name));
  }

  table(name: string): Table {
    const t = this.tables.get(name);
    if (t === undefined) throw new Error(`unknown table: ${name}`);
    return t;
  }

  /** Begin a transaction at the current committed snapshot. */
  begin(): Transaction {
    return new Transaction(this, this.lastCommitTs);
  }

  /** Database-wide commit log, in commit order (the barrier history). */
  commitLog(): readonly CommitRecord[] {
    return this.log;
  }

  /** Full committed version history of one key, ascending commitTs. */
  versionHistory(table: string, key: Key): readonly Version[] {
    return this.table(table).history(key);
  }

  /** Internal: monotonically increasing commit timestamps (with gaps). */
  allocateCommitTs(): number {
    return ++this.lastCommitTs;
  }

  /** Internal: publish a validated transaction's writes atomically. */
  applyCommit(txn: Transaction, commitTs: number): CommitRecord {
    const writes: Array<{ table: string; key: Key; value: Value | null }> = [];
    for (const [tableName, bucket] of txn.stagedWrites()) {
      const table = this.table(tableName);
      for (const [key, value] of bucket) {
        table.appendVersion(key, { value, commitTs });
        writes.push({ table: tableName, key, value });
      }
    }
    const record: CommitRecord = { commitTs, startTs: txn.startTs, writes };
    this.log.push(record);
    return record;
  }
}
