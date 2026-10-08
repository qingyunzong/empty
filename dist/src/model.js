"use strict";
/**
 * Reference model used to verify the real Database.
 *
 * ModelTable is a deliberately naive replica: it applies the same logical
 * operations to plain Maps and rebuilds *all* of its indexes from scratch
 * after every committed transaction. The randomized verifier cross-checks
 * the real database's incrementally maintained indexes against these
 * fully rebuilt ones.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ModelTable = void 0;
class ModelTable {
    schema;
    rows = new Map();
    nextId = 1;
    constructor(schema) {
        this.schema = schema;
    }
    insert(row) {
        const id = this.nextId++;
        this.assertUnique(id, row);
        this.rows.set(id, { ...row });
        return id;
    }
    update(id, patch) {
        const current = this.rows.get(id);
        if (!current)
            throw new Error(`model: missing row ${id}`);
        const next = { ...current, ...patch };
        this.assertUnique(id, next);
        this.rows.set(id, next);
    }
    delete(id) {
        if (!this.rows.delete(id))
            throw new Error(`model: missing row ${id}`);
    }
    /** Applies a committed change batch (mirrors subscriber notifications). */
    apply(changes) {
        for (const change of changes) {
            if (change.type === "insert" || change.type === "update") {
                this.rows.set(change.id, { ...change.after });
            }
            else {
                this.rows.delete(change.id);
            }
        }
    }
    query(field, value) {
        return [...this.rows.values()]
            .filter((row) => row[field] === value)
            .map((row) => ({ ...row }));
    }
    /**
     * Rebuilds every index from the current row set — the ground truth that
     * Database.indexSnapshot is compared against.
     */
    rebuildIndexes() {
        const sortEntries = (map) => [...map.entries()].sort((a, b) => compareKeys(a[0], b[0]));
        const indexes = {};
        for (const field of this.schema.indexedFields ?? []) {
            const map = new Map();
            for (const [id, row] of this.rows) {
                const value = row[field];
                const list = map.get(value) ?? [];
                list.push(id);
                map.set(value, list);
            }
            indexes[field] = sortEntries(map).map(([value, ids]) => [
                value,
                ids.sort((a, b) => a - b),
            ]);
        }
        const uniqueIndexes = {};
        for (const field of this.schema.uniqueFields ?? []) {
            const map = new Map();
            for (const [id, row] of this.rows) {
                map.set(row[field], id);
            }
            uniqueIndexes[field] = sortEntries(map);
        }
        return { indexes, uniqueIndexes };
    }
    assertUnique(selfId, row) {
        for (const field of this.schema.uniqueFields ?? []) {
            for (const [id, existing] of this.rows) {
                if (id !== selfId && existing[field] === row[field]) {
                    throw new Error(`model: unique violation on ${field}`);
                }
            }
        }
    }
}
exports.ModelTable = ModelTable;
function compareKeys(a, b) {
    if (typeof a === "number" && typeof b === "number")
        return a - b;
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}
