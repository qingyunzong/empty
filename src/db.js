// Offline budget settlement library.
//
// Concurrency model:
// - Snapshot isolation: each transaction reads a consistent snapshot taken at
//   begin() time.
// - First-committer-wins on normal keys: if a key written by this transaction
//   was committed by another transaction after our snapshot, commit fails with
//   E_WRITE_CONFLICT.
// - Predicate conflict detection: reading a category's budget balance records
//   a predicate on that category. At commit time, if any other transaction
//   committed a settle/cancel in that category after our snapshot, commit
//   fails with E_PRED_CONFLICT. This prevents two concurrent transactions from
//   both observing sufficient budget and over-committing the category.

export class BudgetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BudgetError';
    this.code = code;
  }
}

export const E_PRED_CONFLICT = 'E_PRED_CONFLICT';
export const E_WRITE_CONFLICT = 'E_WRITE_CONFLICT';
export const E_BUDGET = 'E_BUDGET';
export const E_NOT_FOUND = 'E_NOT_FOUND';
export const E_VALIDATION = 'E_VALIDATION';

const STATUS_SETTLED = 'settled';
const STATUS_CANCELLED = 'cancelled';

export function recordKey(id) {
  return `settlement:${id}`;
}

function indexKey(category, status) {
  return `${category}${status}`;
}

function assertCategory(category) {
  if (typeof category !== 'string' || category.length === 0) {
    throw new BudgetError(E_VALIDATION, 'category must be a non-empty string');
  }
}

function assertAmount(amount) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new BudgetError(E_VALIDATION, 'amount must be a positive integer');
  }
}

export class BudgetDB {
  constructor() {
    this.seq = 0;
    // key -> [{seq, value}] ascending by seq (committed versions)
    this.keys = new Map();
    // (category,status) secondary index:
    // `${cat}${status}` -> Map(id -> [{seq, op: 'add'|'del'}])
    this.index = new Map();
    // category -> seq of last committed settle/cancel affecting it
    this.categoryVersion = new Map();
    // category -> periodic spending limit
    this.budgets = new Map();
  }

  setBudget(category, limit) {
    assertCategory(category);
    if (!Number.isInteger(limit) || limit < 0) {
      throw new BudgetError(E_VALIDATION, 'limit must be a non-negative integer');
    }
    this.budgets.set(category, limit);
  }

  getBudget(category) {
    return this.budgets.has(category) ? this.budgets.get(category) : Infinity;
  }

  begin() {
    return new Transaction(this, this.seq);
  }

  _latestCommittedSeq(key) {
    const versions = this.keys.get(key);
    return versions ? versions[versions.length - 1].seq : 0;
  }

  _readCommitted(key, snapshotSeq) {
    const versions = this.keys.get(key);
    if (!versions) return undefined;
    let result;
    for (const version of versions) {
      if (version.seq <= snapshotSeq) result = version.value;
      else break;
    }
    return result;
  }

  _indexVisibleIds(category, status, snapshotSeq) {
    const bucket = this.index.get(indexKey(category, status));
    const ids = [];
    if (!bucket) return ids;
    for (const [id, versions] of bucket) {
      let present = false;
      for (const version of versions) {
        if (version.seq <= snapshotSeq) present = version.op === 'add';
        else break;
      }
      if (present) ids.push(id);
    }
    return ids;
  }

  _indexAppend(category, status, id, seq, op) {
    const key = indexKey(category, status);
    let bucket = this.index.get(key);
    if (!bucket) {
      bucket = new Map();
      this.index.set(key, bucket);
    }
    let versions = bucket.get(id);
    if (!versions) {
      versions = [];
      bucket.set(id, versions);
    }
    versions.push({ seq, op });
  }

  // Reference algorithm: full-table scan summing settled amounts.
  usedByScan(category, snapshotSeq = this.seq) {
    let used = 0;
    for (const [key] of this.keys) {
      if (!key.startsWith('settlement:')) continue;
      const record = this._readCommitted(key, snapshotSeq);
      if (record && record.category === category && record.status === STATUS_SETTLED) {
        used += record.amount;
      }
    }
    return used;
  }

  toJSON() {
    const settlements = [];
    for (const [key] of this.keys) {
      if (!key.startsWith('settlement:')) continue;
      settlements.push(this._readCommitted(key, this.seq));
    }
    return {
      budgets: Object.fromEntries(this.budgets),
      settlements,
    };
  }

  static fromJSON(data) {
    const db = new BudgetDB();
    if (data && typeof data === 'object') {
      if (data.budgets && typeof data.budgets === 'object') {
        for (const [category, limit] of Object.entries(data.budgets)) {
          db.setBudget(category, limit);
        }
      }
      const settlements = Array.isArray(data.settlements) ? data.settlements : [];
      for (const record of settlements) {
        if (!record || typeof record.id !== 'string') continue;
        db.seq += 1;
        const seq = db.seq;
        db.keys.set(recordKey(record.id), [{ seq, value: record }]);
        db._indexAppend(record.category, record.status, record.id, seq, 'add');
        db.categoryVersion.set(record.category, seq);
      }
    }
    return db;
  }
}

export class Transaction {
  constructor(db, snapshotSeq) {
    this.db = db;
    this.snapshotSeq = snapshotSeq;
    this.writes = new Map();
    this.predicateCategories = new Set();
    this.committed = false;
  }

  get(key) {
    if (this.writes.has(key)) return this.writes.get(key);
    return this.db._readCommitted(key, this.snapshotSeq);
  }

  // Remaining budget for a category as of this transaction's snapshot.
  // Records a predicate on the category: commit will fail with
  // E_PRED_CONFLICT if anyone else settled/cancelled in it after our snapshot.
  available(category) {
    assertCategory(category);
    this.predicateCategories.add(category);
    const ids = this.db._indexVisibleIds(category, STATUS_SETTLED, this.snapshotSeq);
    let used = 0;
    for (const id of ids) {
      const record = this.get(recordKey(id));
      if (record && record.status === STATUS_SETTLED) used += record.amount;
    }
    // Account for this transaction's own staged writes.
    for (const record of this.writes.values()) {
      if (record.category !== category) continue;
      if (record.status === STATUS_SETTLED) used += record.amount;
      else if (ids.includes(record.id)) used -= record.amount;
    }
    return this.db.getBudget(category) - used;
  }

  settle({ id, category, amount }) {
    assertCategory(category);
    assertAmount(amount);
    if (typeof id !== 'string' || id.length === 0) {
      throw new BudgetError(E_VALIDATION, 'id must be a non-empty string');
    }
    if (this.get(recordKey(id))) {
      throw new BudgetError(E_VALIDATION, `settlement ${id} already exists`);
    }
    if (amount > this.available(category)) {
      throw new BudgetError(E_BUDGET,
        `amount ${amount} exceeds available budget for category ${category}`);
    }
    this.writes.set(recordKey(id), { id, category, amount, status: STATUS_SETTLED });
    return id;
  }

  cancel(id) {
    const key = recordKey(id);
    const record = this.get(key);
    if (!record) {
      throw new BudgetError(E_NOT_FOUND, `settlement ${id} not found`);
    }
    if (record.status === STATUS_CANCELLED) {
      throw new BudgetError(E_VALIDATION, `settlement ${id} already cancelled`);
    }
    this.writes.set(key, { ...record, status: STATUS_CANCELLED });
  }

  commit() {
    if (this.committed) {
      throw new BudgetError(E_VALIDATION, 'transaction already committed');
    }
    // First-committer-wins on written keys.
    for (const key of this.writes.keys()) {
      if (this.db._latestCommittedSeq(key) > this.snapshotSeq) {
        throw new BudgetError(E_WRITE_CONFLICT,
          `key ${key} was modified after snapshot`);
      }
    }
    // Predicate conflict check on budget-balance reads.
    for (const category of this.predicateCategories) {
      if ((this.db.categoryVersion.get(category) ?? 0) > this.snapshotSeq) {
        throw new BudgetError(E_PRED_CONFLICT,
          `category ${category} changed after snapshot`);
      }
    }
    const seq = ++this.db.seq;
    for (const [key, value] of this.writes) {
      const previous = this.db._readCommitted(key, seq - 1);
      let versions = this.db.keys.get(key);
      if (!versions) {
        versions = [];
        this.db.keys.set(key, versions);
      }
      versions.push({ seq, value });
      if (key.startsWith('settlement:')) {
        if (previous && previous.status !== value.status) {
          this.db._indexAppend(value.category, previous.status, value.id, seq, 'del');
        }
        if (!previous || previous.status !== value.status) {
          this.db._indexAppend(value.category, value.status, value.id, seq, 'add');
        }
        this.db.categoryVersion.set(value.category, seq);
      }
    }
    this.committed = true;
    return seq;
  }
}

// Convenience helper: run fn in a transaction, retrying on E_PRED_CONFLICT.
export function transact(db, fn, { retries = 10 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const tx = db.begin();
    try {
      const result = fn(tx);
      tx.commit();
      return result;
    } catch (err) {
      if (err instanceof BudgetError && err.code === E_PRED_CONFLICT && attempt < retries) {
        continue;
      }
      throw err;
    }
  }
}
