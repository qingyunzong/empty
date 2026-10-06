"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InvalidCursorError = exports.StaleCursorError = exports.Table = void 0;
exports.compareKeys = compareKeys;
exports.compareTriples = compareTriples;
exports.fullJoin = fullJoin;
exports.joinPage = joinPage;
exports.joinAll = joinAll;
const base64_1 = require("./base64");
let nextTableToken = 0;
/**
 * A mutable table. Every mutation bumps `version`, which invalidates any
 * cursor issued against an earlier version (see `joinPage`). Each instance
 * also carries a unique `token` so cursors can never be replayed against a
 * different table that happens to share the same version counter.
 */
class Table {
    token = `table-${nextTableToken++}`;
    rows = new Map();
    nextId = 1;
    versionCounter = 0;
    constructor(initial = []) {
        for (const row of initial) {
            this.insert(row.key);
        }
    }
    get version() {
        return this.versionCounter;
    }
    insert(key) {
        const id = this.nextId++;
        this.rows.set(id, { id, key });
        this.versionCounter++;
        return id;
    }
    update(id, key) {
        const existing = this.rows.get(id);
        if (!existing) {
            throw new Error(`cannot update: row ${id} does not exist`);
        }
        this.rows.set(id, { id, key });
        this.versionCounter++;
    }
    delete(id) {
        if (!this.rows.delete(id)) {
            throw new Error(`cannot delete: row ${id} does not exist`);
        }
        this.versionCounter++;
    }
    /** Immutable point-in-time view of the rows, used by snapshots/tests. */
    snapshot() {
        return [...this.rows.values()].map((row) => ({ ...row }));
    }
}
exports.Table = Table;
class StaleCursorError extends Error {
    constructor(message) {
        super(message);
        this.name = "StaleCursorError";
    }
}
exports.StaleCursorError = StaleCursorError;
class InvalidCursorError extends Error {
    constructor(message) {
        super(message);
        this.name = "InvalidCursorError";
    }
}
exports.InvalidCursorError = InvalidCursorError;
/** Total order over non-null keys: numbers first (numeric), then strings. */
function compareKeys(a, b) {
    if (typeof a === "number" && typeof b === "number") {
        return a - b;
    }
    if (typeof a === "number")
        return -1;
    if (typeof b === "number")
        return 1;
    return a < b ? -1 : a > b ? 1 : 0;
}
/** Result ordering: key, then left id, then right id. */
function compareTriples(a, b) {
    return (compareKeys(a.key, b.key) ||
        a.leftId - b.leftId ||
        a.rightId - b.rightId);
}
function encodeCursor(payload) {
    return (0, base64_1.encodeBase64Url)(JSON.stringify(payload));
}
function decodeCursor(cursor) {
    let parsed;
    try {
        parsed = JSON.parse((0, base64_1.decodeBase64Url)(cursor));
    }
    catch {
        throw new InvalidCursorError("cursor is not valid base64url JSON");
    }
    const payload = parsed;
    const pin = payload?.left;
    const pinR = payload?.right;
    if (payload === null ||
        typeof payload !== "object" ||
        typeof pin?.token !== "string" ||
        typeof pin?.version !== "number" ||
        typeof pinR?.token !== "string" ||
        typeof pinR?.version !== "number" ||
        !("last" in payload)) {
        throw new InvalidCursorError("cursor payload is malformed");
    }
    return payload;
}
/**
 * Full inner join of two row snapshots. Rows with a null key never match
 * anything (including other nulls). Output is sorted by (key, leftId, rightId).
 */
function fullJoin(leftRows, rightRows) {
    const rightByKey = new Map();
    for (const row of rightRows) {
        if (row.key === null)
            continue;
        const bucket = rightByKey.get(row.key);
        if (bucket) {
            bucket.push(row.id);
        }
        else {
            rightByKey.set(row.key, [row.id]);
        }
    }
    const triples = [];
    for (const left of leftRows) {
        if (left.key === null)
            continue;
        const matches = rightByKey.get(left.key);
        if (!matches)
            continue;
        for (const rightId of matches) {
            triples.push({ key: left.key, leftId: left.id, rightId });
        }
    }
    triples.sort(compareTriples);
    return triples;
}
/**
 * One page of the inner join between `left` and `right`.
 *
 * The cursor pins the versions of both tables plus the last emitted
 * (key, leftId, rightId) triple. Resuming with a cursor after either table
 * was modified throws `StaleCursorError`, so pages from different table
 * generations can never be mixed.
 */
function joinPage(left, right, options) {
    const { limit, cursor } = options;
    if (!Number.isInteger(limit) || limit <= 0) {
        throw new RangeError("limit must be a positive integer");
    }
    let after = null;
    if (cursor !== undefined) {
        const payload = decodeCursor(cursor);
        if (payload.left.token !== left.token ||
            payload.left.version !== left.version ||
            payload.right.token !== right.token ||
            payload.right.version !== right.version) {
            throw new StaleCursorError(`cursor was issued for tables (${payload.left.token}@${payload.left.version}, ` +
                `${payload.right.token}@${payload.right.version}) but current tables are ` +
                `(${left.token}@${left.version}, ${right.token}@${right.version}); ` +
                `restart pagination from scratch`);
        }
        after = payload.last;
    }
    const all = fullJoin(left.snapshot(), right.snapshot());
    let start = 0;
    if (after !== null) {
        start = all.findIndex((triple) => compareTriples(triple, after) > 0);
        if (start === -1)
            start = all.length;
    }
    const rows = all.slice(start, start + limit);
    const exhausted = start + limit >= all.length;
    const last = rows.length > 0 ? rows[rows.length - 1] : after;
    const nextCursor = exhausted || last === null
        ? null
        : encodeCursor({
            left: { token: left.token, version: left.version },
            right: { token: right.token, version: right.version },
            last,
        });
    return { rows, nextCursor };
}
/** Convenience helper: drain every page into a single array. */
function joinAll(left, right, pageSize = 100) {
    const out = [];
    let cursor;
    for (;;) {
        const page = joinPage(left, right, { limit: pageSize, cursor });
        out.push(...page.rows);
        if (page.nextCursor === null)
            return out;
        cursor = page.nextCursor;
    }
}
