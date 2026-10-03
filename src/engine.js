export class BudgetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BudgetError';
    this.code = code;
  }
}

export const STATUS_SETTLED = 'settled';
export const STATUS_CANCELLED = 'cancelled';

function indexKey(category, status) {
  return `${category}${status}`;
}

export class BudgetEngine {
  constructor() {
    this.budgets = new Map(); // category -> periodic cap
    this.entries = new Map(); // id -> committed immutable entry
    this.index = new Map(); // "category|status" -> Set<id> (secondary index)
    this.keyVersion = new Map(); // id -> commit version that last wrote the key
    this.categoryVersion = new Map(); // category -> commit version that last changed it
    this.version = 0;
    this.nextId = 1;
  }

  static fromJSON(data) {
    const engine = new BudgetEngine();
    for (const [category, cap] of Object.entries(data.budgets ?? {})) {
      engine.budgets.set(category, cap);
    }
    for (const entry of data.entries ?? []) {
      engine.entries.set(entry.id, entry);
      engine._indexAdd(entry);
      const numericId = Number(entry.id);
      if (Number.isInteger(numericId) && numericId >= engine.nextId) {
        engine.nextId = numericId + 1;
      }
    }
    if (Number.isInteger(data.nextId) && data.nextId > engine.nextId) {
      engine.nextId = data.nextId;
    }
    return engine;
  }

  toJSON() {
    return {
      budgets: Object.fromEntries(this.budgets),
      entries: [...this.entries.values()],
      nextId: this.nextId,
    };
  }

  setBudget(category, cap) {
    if (!Number.isInteger(cap) || cap < 0) {
      throw new BudgetError('E_INVALID', `cap for "${category}" must be a non-negative integer`);
    }
    this.budgets.set(category, cap);
    this._bumpCategory(category);
  }

  getEntry(id) {
    return this.entries.get(id) ?? null;
  }

  available(category) {
    return this._cap(category) - this.usedByCategoryIndex(category);
  }

  usedByCategoryIndex(category) {
    let sum = 0;
    const ids = this.index.get(indexKey(category, STATUS_SETTLED));
    if (ids) {
      for (const id of ids) sum += this.entries.get(id).amount;
    }
    return sum;
  }

  // Reference algorithm: full-table sum, used to cross-check the index.
  usedByCategoryScan(category) {
    let sum = 0;
    for (const entry of this.entries.values()) {
      if (entry.category === category && entry.status === STATUS_SETTLED) {
        sum += entry.amount;
      }
    }
    return sum;
  }

  indexEntries(category, status) {
    const ids = this.index.get(indexKey(category, status));
    return ids ? [...ids].map((id) => this.entries.get(id)) : [];
  }

  begin() {
    return new Transaction(this);
  }

  _cap(category) {
    const cap = this.budgets.get(category);
    if (cap === undefined) {
      throw new BudgetError('E_NO_BUDGET', `no budget configured for category "${category}"`);
    }
    return cap;
  }

  _bumpCategory(category) {
    this.version += 1;
    this.categoryVersion.set(category, this.version);
  }

  _indexAdd(entry) {
    const key = indexKey(entry.category, entry.status);
    let bucket = this.index.get(key);
    if (!bucket) {
      bucket = new Set();
      this.index.set(key, bucket);
    }
    bucket.add(entry.id);
  }

  _indexRemove(entry) {
    const bucket = this.index.get(indexKey(entry.category, entry.status));
    if (bucket) bucket.delete(entry.id);
  }

  _commit(txn) {
    if (txn.state !== 'active') {
      throw new BudgetError('E_TXN_STATE', `transaction is ${txn.state}`);
    }
    txn.state = 'aborted';

    // First-committer-wins on normal keys.
    for (const id of txn.writes.keys()) {
      const version = this.keyVersion.get(id) ?? 0;
      if (version > txn.snapshotVersion) {
        throw new BudgetError('E_CONFLICT', `write-write conflict on entry ${id}`);
      }
    }

    // Predicate conflict check: the transaction decided to insert/cancel based
    // on the category balance; abort if the category changed since the snapshot.
    for (const category of txn.predicateReads) {
      const version = this.categoryVersion.get(category) ?? 0;
      if (version > txn.snapshotVersion) {
        throw new BudgetError(
          'E_PRED_CONFLICT',
          `category "${category}" changed since transaction snapshot`,
        );
      }
    }

    // Budget validation against committed state plus this transaction's writes.
    const affected = new Set();
    for (const entry of txn.writes.values()) affected.add(entry.category);
    for (const category of affected) {
      const cap = this._cap(category);
      let used = this.usedByCategoryScan(category);
      for (const entry of txn.writes.values()) {
        if (entry.category !== category) continue;
        const previous = this.entries.get(entry.id);
        if (previous && previous.status === STATUS_SETTLED) used -= previous.amount;
        if (entry.status === STATUS_SETTLED) used += entry.amount;
      }
      if (used > cap) {
        throw new BudgetError(
          'E_BUDGET',
          `category "${category}" budget exceeded: ${used} > ${cap}`,
        );
      }
    }

    const commitVersion = ++this.version;
    for (const entry of txn.writes.values()) {
      const previous = this.entries.get(entry.id);
      if (previous) this._indexRemove(previous);
      this.entries.set(entry.id, entry);
      this._indexAdd(entry);
      this.keyVersion.set(entry.id, commitVersion);
      this.categoryVersion.set(entry.category, commitVersion);
    }
    txn.state = 'committed';
    return commitVersion;
  }
}

export class Transaction {
  constructor(engine) {
    this.engine = engine;
    this.snapshotVersion = engine.version;
    this.snapshot = new Map(engine.entries); // snapshot isolation: frozen view
    this.predicateReads = new Set(); // categories whose balance was observed
    this.writes = new Map(); // id -> staged entry
    this.state = 'active';
  }

  available(category) {
    this._assertActive();
    this.predicateReads.add(category);
    const cap = this.engine._cap(category);
    let used = 0;
    for (const entry of this._visible().values()) {
      if (entry.category === category && entry.status === STATUS_SETTLED) {
        used += entry.amount;
      }
    }
    return cap - used;
  }

  getEntry(id) {
    this._assertActive();
    return this._visible().get(id) ?? null;
  }

  settle(category, amount) {
    this._assertActive();
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BudgetError('E_INVALID', `amount must be a positive integer, got ${amount}`);
    }
    this.engine._cap(category);
    this.predicateReads.add(category);
    const id = String(this.engine.nextId++);
    this.writes.set(id, { id, category, amount, status: STATUS_SETTLED });
    return id;
  }

  cancel(id) {
    this._assertActive();
    const existing = this.getEntry(id);
    if (!existing) {
      throw new BudgetError('E_NOT_FOUND', `entry ${id} not found`);
    }
    if (existing.status === STATUS_CANCELLED) {
      throw new BudgetError('E_ALREADY_CANCELLED', `entry ${id} is already cancelled`);
    }
    this.predicateReads.add(existing.category);
    this.writes.set(id, { ...existing, status: STATUS_CANCELLED });
  }

  commit() {
    return this.engine._commit(this);
  }

  _visible() {
    const merged = new Map(this.snapshot);
    for (const [id, entry] of this.writes) merged.set(id, entry);
    return merged;
  }

  _assertActive() {
    if (this.state !== 'active') {
      throw new BudgetError('E_TXN_STATE', `transaction is ${this.state}`);
    }
  }
}
