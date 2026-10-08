"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.Transaction = exports.Database = exports.UniqueConstraintError = void 0;
class UniqueConstraintError extends Error {
    table;
    field;
    value;
    constructor(table, field, value) {
        super(`unique constraint violation on ${table}.${field} for value ${JSON.stringify(value)}`);
        this.table = table;
        this.field = field;
        this.value = value;
        this.name = "UniqueConstraintError";
    }
}
exports.UniqueConstraintError = UniqueConstraintError;
class Table {
    schema;
    rows = new Map();
    indexes = new Map();
    uniqueIndexes = new Map();
    nextId = 1;
    constructor(schema) {
        this.schema = schema;
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
    get indexedFields() {
        return [...this.indexes.keys()];
    }
    get uniqueFields() {
        return [...this.uniqueIndexes.keys()];
    }
}
class Database {
    tables = new Map();
    subscribers = new Map();
    activeTx = null;
    createTable(schema) {
        if (this.tables.has(schema.name)) {
            throw new Error(`table ${schema.name} already exists`);
        }
        this.tables.set(schema.name, new Table(schema));
    }
    subscribe(table, subscriber) {
        this.table(table); // ensure the table exists
        const list = this.subscribers.get(table) ?? [];
        list.push(subscriber);
        this.subscribers.set(table, list);
        return () => {
            const current = this.subscribers.get(table);
            if (!current)
                return;
            const index = current.indexOf(subscriber);
            if (index >= 0)
                current.splice(index, 1);
        };
    }
    /**
     * Runs `fn` inside a transaction. Staged writes are validated and applied
     * atomically when `fn` returns; any throw discards all staged writes.
     * Subscribers are notified after the commit with coalesced changes.
     */
    transaction(fn) {
        if (this.activeTx) {
            throw new Error("nested transactions are not supported; open a new transaction after commit");
        }
        const tx = new Transaction(this);
        this.activeTx = tx;
        let result;
        try {
            result = fn(tx);
        }
        finally {
            this.activeTx = null;
        }
        this.commit(tx);
        return result;
    }
    /** Committed-state read. */
    get(table, id) {
        const row = this.table(table).rows.get(id);
        return row ? { ...row } : undefined;
    }
    /** Committed-state index lookup: field value -> rows. */
    query(table, field, value) {
        return this.idsFor(this.table(table), field, value).map((id) => ({ ...this.table(table).rows.get(id) }));
    }
    all(table) {
        return [...this.table(table).rows.values()].map((row) => ({ ...row }));
    }
    /**
     * Serializable snapshot of every index, for verification against a model.
     * Non-unique: field -> [[value, sortedIds]]. Unique: field -> [[value, id]].
     */
    indexSnapshot(table) {
        const t = this.table(table);
        const sortEntries = (map) => [...map.entries()].sort((a, b) => compareKeys(a[0], b[0]));
        const indexes = {};
        for (const [field, map] of t.indexes) {
            indexes[field] = sortEntries(map).map(([value, ids]) => [
                value,
                [...ids].sort((a, b) => a - b),
            ]);
        }
        const uniqueIndexes = {};
        for (const [field, map] of t.uniqueIndexes) {
            uniqueIndexes[field] = sortEntries(map);
        }
        return { indexes, uniqueIndexes };
    }
    idsFor(table, field, value) {
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
    commit(tx) {
        const staged = tx.drain();
        if (staged.size === 0)
            return;
        // Phase 1: validate unique constraints against the batch's final state.
        // Removals are conceptually applied before additions, which is what
        // allows two rows to swap unique keys within one transaction.
        for (const [tableName, rows] of staged) {
            const table = this.table(tableName);
            for (const field of table.uniqueFields) {
                const index = table.uniqueIndexes.get(field);
                const claimed = new Map();
                for (const [id, change] of rows) {
                    if (change.after === undefined)
                        continue;
                    const value = change.after[field];
                    const existingClaim = claimed.get(value);
                    if (existingClaim !== undefined && existingClaim !== id) {
                        throw new UniqueConstraintError(tableName, field, value);
                    }
                    claimed.set(value, id);
                    const owner = index.get(value);
                    if (owner !== undefined && owner !== id) {
                        const ownerChange = rows.get(owner);
                        const ownerMovesAway = ownerChange !== undefined &&
                            (ownerChange.after === undefined || ownerChange.after[field] !== value);
                        if (!ownerMovesAway) {
                            throw new UniqueConstraintError(tableName, field, value);
                        }
                    }
                }
            }
        }
        // Phase 2: apply. Validation is complete, so this cannot fail.
        const results = [];
        for (const [tableName, rows] of staged) {
            const table = this.table(tableName);
            const changes = [];
            for (const [id, change] of rows) {
                const { before, after } = change;
                if (before === undefined && after === undefined)
                    continue;
                if (before !== undefined && after !== undefined && shallowEqual(before, after)) {
                    continue; // touched but net-zero
                }
                if (before !== undefined)
                    removeFromIndexes(table, id, before);
                if (after !== undefined)
                    addToIndexes(table, id, after);
                if (after === undefined)
                    table.rows.delete(id);
                else
                    table.rows.set(id, { ...after });
                changes.push({
                    type: before === undefined ? "insert" : after === undefined ? "delete" : "update",
                    id,
                    before: before ? { ...before } : undefined,
                    after: after ? { ...after } : undefined,
                });
            }
            if (changes.length > 0)
                results.push({ table: tableName, changes });
        }
        // Phase 3: publish after the commit is fully applied. Subscribers may
        // reenter the database, including starting (and committing) new
        // transactions; their notifications nest inside this loop safely.
        for (const { table, changes } of results) {
            const list = this.subscribers.get(table);
            if (!list)
                continue;
            for (const subscriber of [...list]) {
                subscriber(changes, this);
            }
        }
    }
    table(name) {
        const table = this.tables.get(name);
        if (!table)
            throw new Error(`unknown table ${name}`);
        return table;
    }
    /** Internal accessors used by Transaction. */
    tableFor(name) {
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
exports.Database = Database;
class Transaction {
    db;
    staged = new Map();
    closed = false;
    constructor(db) {
        this.db = db;
    }
    insert(table, row) {
        this.ensureOpen();
        const handle = this.db.tableFor(table);
        const id = handle.allocateId();
        this.stagedRows(table).set(id, { before: undefined, after: { ...row } });
        return id;
    }
    update(table, id, patch) {
        this.ensureOpen();
        const current = this.read(table, id);
        if (current === undefined) {
            throw new Error(`cannot update missing row ${table}#${id}`);
        }
        this.stage(table, id).after = { ...current, ...patch };
    }
    delete(table, id) {
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
    get(table, id) {
        this.ensureOpen();
        const row = this.read(table, id);
        return row ? { ...row } : undefined;
    }
    /** Read-your-writes index lookup. */
    query(table, field, value) {
        this.ensureOpen();
        const handle = this.db.tableFor(table);
        const ids = new Set(handle.committedIdsFor(field, value));
        for (const [id, change] of this.stagedRows(table)) {
            const beforeMatch = change.before !== undefined && change.before[field] === value;
            const afterMatch = change.after !== undefined && change.after[field] === value;
            if (beforeMatch && !afterMatch)
                ids.delete(id);
            if (afterMatch)
                ids.add(id);
        }
        return [...ids]
            .sort((a, b) => a - b)
            .map((id) => this.read(table, id))
            .filter((row) => row !== undefined)
            .map((row) => ({ ...row }));
    }
    /** Consumed by Database.commit. */
    drain() {
        this.closed = true;
        return this.staged;
    }
    read(table, id) {
        const staged = this.stagedRows(table).get(id);
        if (staged)
            return staged.after;
        return this.db.tableFor(table).rows.get(id);
    }
    stage(table, id) {
        const rows = this.stagedRows(table);
        let staged = rows.get(id);
        if (!staged) {
            staged = { before: this.db.tableFor(table).rows.get(id), after: undefined };
            staged.after = staged.before ? { ...staged.before } : undefined;
            rows.set(id, staged);
        }
        return staged;
    }
    stagedRows(table) {
        let rows = this.staged.get(table);
        if (!rows) {
            rows = new Map();
            this.staged.set(table, rows);
        }
        return rows;
    }
    ensureOpen() {
        if (this.closed)
            throw new Error("transaction already committed");
    }
}
exports.Transaction = Transaction;
function addToIndexes(table, id, row) {
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
function removeFromIndexes(table, id, row) {
    for (const [field, index] of table.indexes) {
        const ids = index.get(row[field]);
        if (!ids)
            continue;
        ids.delete(id);
        if (ids.size === 0)
            index.delete(row[field]);
    }
    for (const [field, index] of table.uniqueIndexes) {
        if (index.get(row[field]) === id)
            index.delete(row[field]);
    }
}
function shallowEqual(a, b) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length)
        return false;
    return aKeys.every((key) => a[key] === b[key]);
}
function compareKeys(a, b) {
    if (typeof a === "number" && typeof b === "number")
        return a - b;
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}
