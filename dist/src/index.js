import { createHash, randomUUID } from "node:crypto";
export class InvalidCursorError extends Error {
    constructor(message = "cursor is malformed") {
        super(message);
        this.name = "InvalidCursorError";
    }
}
export class StaleCursorError extends Error {
    constructor(message = "cursor was issued by a different index version") {
        super(message);
        this.name = "StaleCursorError";
    }
}
export class CursorQueryMismatchError extends Error {
    constructor(message = "cursor was issued for a different query") {
        super(message);
        this.name = "CursorQueryMismatchError";
    }
}
/** Canonical form used for both matching and the query digest. */
export function normalizeQuery(query) {
    return query.trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}
export function queryTerms(query) {
    const normalized = normalizeQuery(query);
    return normalized === "" ? [] : normalized.split(" ");
}
export function queryDigest(query) {
    return createHash("sha256").update(normalizeQuery(query), "utf8").digest("hex");
}
/** Deterministic scorer: total occurrences of query terms in the text. */
export function scoreDocument(text, terms) {
    const haystack = text.toLowerCase();
    let score = 0;
    for (const term of terms) {
        let from = 0;
        for (;;) {
            const at = haystack.indexOf(term, from);
            if (at === -1)
                break;
            score += 1;
            from = at + term.length;
        }
    }
    return score;
}
/** Total order: score descending, then id ascending. Deterministic and stable. */
export function compareHits(a, b) {
    if (a.score !== b.score)
        return b.score - a.score;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
export function encodeCursor(payload) {
    return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}
export function decodeCursor(cursor) {
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    }
    catch {
        throw new InvalidCursorError();
    }
    const p = parsed;
    if (p === null ||
        typeof p !== "object" ||
        typeof p.i !== "string" ||
        typeof p.v !== "number" ||
        typeof p.q !== "string" ||
        p.k === null ||
        typeof p.k !== "object" ||
        typeof p.k.s !== "number" ||
        typeof p.k.id !== "string") {
        throw new InvalidCursorError();
    }
    return p;
}
export class SearchIndex {
    docs = new Map();
    indexId = randomUUID();
    version = 0;
    constructor(docs = []) {
        for (const doc of docs)
            this.add(doc);
    }
    get indexVersion() {
        return this.version;
    }
    get size() {
        return this.docs.size;
    }
    add(doc) {
        this.docs.set(doc.id, doc.text);
        this.version += 1;
    }
    update(id, text) {
        if (!this.docs.has(id))
            throw new Error(`unknown document id: ${id}`);
        this.docs.set(id, text);
        this.version += 1;
    }
    remove(id) {
        if (this.docs.delete(id))
            this.version += 1;
    }
    search(query, options) {
        const { limit, cursor, budget = Infinity } = options;
        if (!Number.isInteger(limit) || limit <= 0) {
            throw new RangeError("limit must be a positive integer");
        }
        if (!(budget > 0)) {
            throw new RangeError("budget must be positive");
        }
        const digest = queryDigest(query);
        let afterKey = null;
        if (cursor !== undefined) {
            const payload = decodeCursor(cursor);
            if (payload.i !== this.indexId || payload.v !== this.version) {
                throw new StaleCursorError(`cursor bound to index ${payload.i}@v${payload.v}, current is ${this.indexId}@v${this.version}`);
            }
            if (payload.q !== digest) {
                throw new CursorQueryMismatchError();
            }
            afterKey = payload.k;
        }
        const terms = queryTerms(query);
        const matched = [];
        let scanned = 0;
        let exhausted = false;
        for (const [id, text] of this.docs) {
            if (scanned >= budget) {
                exhausted = true;
                break;
            }
            scanned += 1;
            const score = scoreDocument(text, terms);
            if (score <= 0)
                continue;
            const hit = { id, score };
            if (afterKey !== null && compareHits(hit, { id: afterKey.id, score: afterKey.s }) <= 0) {
                continue;
            }
            matched.push(hit);
        }
        matched.sort(compareHits);
        const hits = matched.slice(0, limit);
        const moreEvaluated = matched.length > limit;
        const last = hits[hits.length - 1];
        const nextCursor = last !== undefined && (moreEvaluated || exhausted)
            ? encodeCursor({
                i: this.indexId,
                v: this.version,
                q: digest,
                k: { s: last.score, id: last.id },
            })
            : null;
        return {
            hits,
            nextCursor,
            complete: !exhausted,
            incompleteReason: exhausted ? "budget_exhausted" : null,
            scanned,
            total: this.docs.size,
            indexVersion: this.version,
            queryDigest: digest,
        };
    }
    /**
     * Independent reference implementation: evaluates every document and
     * returns the full sorted result set. Used to cross-check paginated
     * output (union and order) in tests.
     */
    fullScan(query) {
        const terms = queryTerms(query);
        const all = [];
        for (const [id, text] of this.docs) {
            const score = scoreDocument(text, terms);
            if (score > 0)
                all.push({ id, score });
        }
        all.sort(compareHits);
        return all;
    }
}
