/**
 * MVCC engine providing Snapshot Isolation (SI):
 *
 *  - Each transaction reads from a consistent snapshot taken at begin()
 *    (snapshotTs = lastCommitTs), spanning any number of tables.
 *  - Writes are staged in a private write-set; a transaction always reads
 *    its own staged writes (read-your-own-writes), while other
 *    transactions never see them until commit.
 *  - Commit validates ONLY the write-set: for every written key it checks
 *    whether a version with commitTs > snapshotTs has appeared since the
 *    snapshot (first-committer-wins). Pure reads and read-set keys are
 *    never validated, therefore write skew is possible under SI.
 */

export type Key = string;
export type Value = string | number | boolean;
/** null models a tombstone (DELETE). */
export type Cell = Value | null;

export interface Version {
  commitTs: number;
  value: Cell;
}

export interface ConflictEvidence {
  table: string;
  key: Key;
  /** Snapshot the conflicting transaction read from. */
  snapshotTs: number;
  /** Version of the same key committed after that snapshot. */
  conflictingCommitTs: number;
}

export class CommitConflictError extends Error {
  readonly txnId: number;
  readonly conflicts: ConflictEvidence[];
  constructor(txnId: number, conflicts: ConflictEvidence[]) {
    super(
      `txn ${txnId} aborted: write-write conflict on ` +
        conflicts.map((c) => `${c.table}(${c.key})@snapshot=${c.snapshotTs}<committed=${c.conflictingCommitTs}`).join(', '),
    );
    this.name = 'CommitConflictError';
    this.txnId = txnId;
    this.conflicts = conflicts;
  }
}

export type HistoryEvent =
  | { kind: 'begin'; txnId: number; snapshotTs: number; epoch: number }
  | { kind: 'read'; txnId: number; table: string; key: Key; value: Cell | undefined }
  | { kind: 'write'; txnId: number; table: string; key: Key; value: Cell }
  | { kind: 'commit'; txnId: number; commitTs: number; writeSet: Array<{ table: string; key: Key; value: Cell }> }
  | { kind: 'abort'; txnId: number; reason: 'conflict' | 'user'; conflicts: ConflictEvidence[] }
  | { kind: 'barrier'; epoch: number };

interface StagedWrite {
  table: string;
  key: Key;
  value: Cell;
}

const compoundKey = (table: string, key: Key): string => `${table}${key}`;

export class Database {
  private tables = new Map<string, Map<Key, Version[]>>();
  private lastCommitTs = 0;
  private nextTxnId = 1;
  private epoch = 0;
  /** Complete observable history, recorded for reconciliation against the model. */
  readonly history: HistoryEvent[] = [];

  createTable(name: string): void {
    if (this.tables.has(name)) throw new Error(`table ${name} already exists`);
    this.tables.set(name, new Map());
  }

  tableNames(): string[] {
    return [...this.tables.keys()];
  }

  /** All keys ever written in a table (used for snapshot scans). */
  keys(table: string): Key[] {
    return [...(this.tables.get(table)?.keys() ?? [])];
  }

  /** Sync point: separates the history into epochs for the barrier-history check. */
  barrier(): void {
    this.epoch += 1;
    this.history.push({ kind: 'barrier', epoch: this.epoch });
  }

  begin(): Transaction {
    const txn = new Transaction(this, this.nextTxnId++, this.lastCommitTs, this.epoch);
    this.history.push({ kind: 'begin', txnId: txn.id, snapshotTs: txn.snapshotTs, epoch: this.epoch });
    return txn;
  }

  /** Latest version of `key` visible at `snapshotTs` (undefined = never existed). */
  visibleVersion(table: string, key: Key, snapshotTs: number): Version | undefined {
    const chain = this.tables.get(table)?.get(key);
    if (!chain) return undefined;
    let lo = 0;
    let hi = chain.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (chain[mid].commitTs <= snapshotTs) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found >= 0 ? chain[found] : undefined;
  }

  /** Commit path: validate write-set versions only, then append new versions. */
  commitTxn(txn: Transaction, staged: StagedWrite[]): number {
    const conflicts: ConflictEvidence[] = [];
    for (const w of staged) {
      const chain = this.tables.get(w.table)?.get(w.key);
      const latest = chain && chain.length > 0 ? chain[chain.length - 1] : undefined;
      if (latest && latest.commitTs > txn.snapshotTs) {
        conflicts.push({
          table: w.table,
          key: w.key,
          snapshotTs: txn.snapshotTs,
          conflictingCommitTs: latest.commitTs,
        });
      }
    }
    if (conflicts.length > 0) {
      this.history.push({ kind: 'abort', txnId: txn.id, reason: 'conflict', conflicts });
      throw new CommitConflictError(txn.id, conflicts);
    }
    const commitTs = ++this.lastCommitTs;
    for (const w of staged) {
      let chain = this.tables.get(w.table)!.get(w.key);
      if (!chain) {
        chain = [];
        this.tables.get(w.table)!.set(w.key, chain);
      }
      chain.push({ commitTs, value: w.value });
    }
    this.history.push({
      kind: 'commit',
      txnId: txn.id,
      commitTs,
      writeSet: staged.map((w) => ({ table: w.table, key: w.key, value: w.value })),
    });
    return commitTs;
  }

  recordAbort(txnId: number): void {
    this.history.push({ kind: 'abort', txnId, reason: 'user', conflicts: [] });
  }

  recordRead(txnId: number, table: string, key: Key, value: Cell | undefined): void {
    this.history.push({ kind: 'read', txnId, table, key, value });
  }

  recordWrite(txnId: number, table: string, key: Key, value: Cell): void {
    this.history.push({ kind: 'write', txnId, table, key, value });
  }

  /** Full version chains, exposed for reconciliation against the model. */
  versionChains(): Map<string, Map<Key, Version[]>> {
    const out = new Map<string, Map<Key, Version[]>>();
    for (const [t, rows] of this.tables) {
      const copy = new Map<Key, Version[]>();
      for (const [k, chain] of rows) copy.set(k, chain.map((v) => ({ ...v })));
      out.set(t, copy);
    }
    return out;
  }
}

export class Transaction {
  readonly id: number;
  readonly snapshotTs: number;
  readonly epoch: number;
  private db: Database;
  private staged = new Map<string, StagedWrite>();
  private done = false;

  constructor(db: Database, id: number, snapshotTs: number, epoch: number) {
    this.db = db;
    this.id = id;
    this.snapshotTs = snapshotTs;
    this.epoch = epoch;
  }

  private ensureActive(): void {
    if (this.done) throw new Error(`txn ${this.id} is no longer active`);
  }

  /** Read-your-own-writes: staged writes overlay the snapshot. */
  read(table: string, key: Key): Cell | undefined {
    this.ensureActive();
    const own = this.staged.get(compoundKey(table, key));
    let value: Cell | undefined;
    if (own) {
      value = own.value === null ? undefined : own.value;
    } else {
      const v = this.db.visibleVersion(table, key, this.snapshotTs);
      value = v === undefined || v.value === null ? undefined : v.value;
    }
    this.db.recordRead(this.id, table, key, value);
    return value;
  }

  write(table: string, key: Key, value: Value): void {
    this.ensureActive();
    this.staged.set(compoundKey(table, key), { table, key, value });
    this.db.recordWrite(this.id, table, key, value);
  }

  delete(table: string, key: Key): void {
    this.ensureActive();
    this.staged.set(compoundKey(table, key), { table, key, value: null });
    this.db.recordWrite(this.id, table, key, null);
  }

  /** Consistent snapshot scan of one table, overlaid with own staged writes. */
  scan(table: string): Array<[Key, Value]> {
    this.ensureActive();
    const result = new Map<Key, Value>();
    for (const key of this.db.keys(table)) {
      const v = this.db.visibleVersion(table, key, this.snapshotTs);
      if (v && v.value !== null) result.set(key, v.value);
    }
    for (const w of this.staged.values()) {
      if (w.table !== table) continue;
      if (w.value === null) result.delete(w.key);
      else result.set(w.key, w.value);
    }
    return [...result.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }

  /** Validates ONLY the write-set against versions committed after the snapshot. */
  commit(): number {
    this.ensureActive();
    this.done = true;
    return this.db.commitTxn(this, [...this.staged.values()]);
  }

  abort(): void {
    this.ensureActive();
    this.done = true;
    this.db.recordAbort(this.id);
  }
}
