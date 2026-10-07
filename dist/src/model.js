"use strict";
/**
 * Core text model.
 *
 * Every character carries a stable {@link CharId} assigned at insertion time.
 * The id never changes for the lifetime of the document, no matter how the
 * character is stored (flat list, pages) or how many edits happen around it.
 *
 * Document order is derived, not stored: each character remembers the id it
 * was inserted after (`afterId`), and characters sharing the same `afterId`
 * are ordered by their insertion operation id. The visible sequence is a
 * pre-order walk of that tree, which makes concurrent inserts at the same
 * position deterministic and merge order-independent.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.Site = exports.TextModel = void 0;
exports.mergeOps = mergeOps;
exports.replay = replay;
const ROOT_KEY = '__root__';
class TextModel {
    nodes = new Map();
    /** Ids deleted before their insert arrived; honoured once they appear. */
    deletedIds = new Set();
    apply(op) {
        if (op.kind === 'insert') {
            if (this.nodes.has(op.id))
                return; // idempotent replay
            this.nodes.set(op.id, {
                id: op.id,
                value: op.value,
                afterId: op.afterId,
                opId: op.opId,
                deleted: this.deletedIds.has(op.id),
            });
        }
        else {
            this.deletedIds.add(op.id);
            const node = this.nodes.get(op.id);
            if (node)
                node.deleted = true; // idempotent, tombstone kept for anchors
        }
    }
    applyAll(ops) {
        for (const op of ops)
            this.apply(op);
    }
    get(id) {
        return this.nodes.get(id);
    }
    has(id) {
        return this.nodes.has(id);
    }
    /**
     * Full document order (including tombstones): pre-order walk where each
     * node's children are the characters inserted after it, sorted by op id.
     */
    order() {
        const children = new Map();
        for (const node of this.nodes.values()) {
            const key = node.afterId !== null && this.nodes.has(node.afterId) ? node.afterId : ROOT_KEY;
            const list = children.get(key);
            if (list)
                list.push(node);
            else
                children.set(key, [node]);
        }
        for (const list of children.values()) {
            list.sort((a, b) => (a.opId < b.opId ? -1 : a.opId > b.opId ? 1 : a.id < b.id ? -1 : 1));
        }
        const out = [];
        const visit = (key) => {
            const list = children.get(key);
            if (!list)
                return;
            for (const node of list) {
                out.push(node.id);
                visit(node.id);
            }
        };
        visit(ROOT_KEY);
        return out;
    }
    /** Ids of surviving characters in document order. */
    liveIds() {
        return this.order().filter((id) => !this.nodes.get(id).deleted);
    }
    text() {
        return this.liveIds()
            .map((id) => this.nodes.get(id).value)
            .join('');
    }
    get length() {
        let n = 0;
        for (const node of this.nodes.values())
            if (!node.deleted)
                n += 1;
        return n;
    }
    /**
     * Resolve a cursor to a gap index in the live sequence (0..length).
     * Deleted anchors gravitate to the nearest surviving character on their
     * right; with no survivor to the right they land at the end of the text.
     */
    resolveCursor(cursor) {
        const live = this.liveIds();
        if (cursor === null)
            return live.length;
        const node = this.nodes.get(cursor);
        if (!node)
            return live.length;
        if (!node.deleted)
            return live.indexOf(cursor);
        const order = this.order();
        for (let i = order.indexOf(cursor) + 1; i < order.length; i += 1) {
            const candidate = this.nodes.get(order[i]);
            if (!candidate.deleted)
                return live.indexOf(candidate.id);
        }
        return live.length;
    }
    /** Resolve a selection to a normalized [start, end) range of gap indices. */
    resolveSelection(selection) {
        const a = this.resolveCursor(selection.anchor);
        const b = this.resolveCursor(selection.head);
        return a <= b ? { start: a, end: b } : { start: b, end: a };
    }
}
exports.TextModel = TextModel;
/**
 * Generates operation ids (and matching character ids) for one editing site.
 * Ids are zero-padded so lexicographic order matches issuance order.
 */
class Site {
    siteId;
    counter = 0;
    constructor(siteId) {
        this.siteId = siteId;
    }
    nextOpId() {
        this.counter += 1;
        return `${this.siteId}#${this.counter.toString().padStart(12, '0')}`;
    }
    insert(afterId, value) {
        const opId = this.nextOpId();
        return { kind: 'insert', opId, id: `c:${opId}`, afterId, value };
    }
    delete(id) {
        return { kind: 'delete', opId: this.nextOpId(), id };
    }
}
exports.Site = Site;
/** Merge op logs, de-duplicated by op id. Application order is irrelevant. */
function mergeOps(...logs) {
    const seen = new Set();
    const out = [];
    for (const log of logs) {
        for (const op of log) {
            if (!seen.has(op.opId)) {
                seen.add(op.opId);
                out.push(op);
            }
        }
    }
    return out;
}
/** Replay an op log into a fresh (or given) model. */
function replay(ops, model = new TextModel()) {
    model.applyAll(ops);
    return model;
}
