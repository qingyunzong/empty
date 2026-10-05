"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Store = exports.BUCKET_COUNT = void 0;
exports.bucketOf = bucketOf;
exports.BUCKET_COUNT = 16;
function bucketOf(key, bucketCount = exports.BUCKET_COUNT) {
    if (!Number.isSafeInteger(key)) {
        throw new RangeError(`key must be a safe integer, got ${key}`);
    }
    return ((key % bucketCount) + bucketCount) % bucketCount;
}
/**
 * Versioned integer-keyed store. Every mutation bumps `version`.
 * Deletions leave tombstones so that "deleted" is distinguishable from
 * "never existed" during reconciliation.
 */
class Store {
    live = new Map();
    tombstones = new Set();
    ver = 0;
    get version() {
        return this.ver;
    }
    set(key, value) {
        this.live.set(key, value);
        this.tombstones.delete(key);
        this.ver++;
    }
    delete(key) {
        if (!this.live.has(key))
            return false;
        this.live.delete(key);
        this.tombstones.add(key);
        this.ver++;
        return true;
    }
    /** Apply a remote entry verbatim, keeping tombstones so digests converge. */
    apply(entry) {
        if (entry.kind === "live") {
            this.live.set(entry.key, entry.value);
            this.tombstones.delete(entry.key);
        }
        else {
            this.live.delete(entry.key);
            this.tombstones.add(entry.key);
        }
        this.ver++;
    }
    /** Remove a key entirely (no tombstone) so divergent local state converges. */
    purge(key) {
        if (this.live.delete(key) || this.tombstones.delete(key))
            this.ver++;
    }
    has(key) {
        return this.live.has(key);
    }
    get(key) {
        return this.live.get(key);
    }
    /** Live entries + tombstones of one bucket, sorted by key ascending. */
    entriesInBucket(index, bucketCount = exports.BUCKET_COUNT) {
        const out = [];
        for (const [key, value] of this.live) {
            if (bucketOf(key, bucketCount) === index)
                out.push({ kind: "live", key, value });
        }
        for (const key of this.tombstones) {
            if (bucketOf(key, bucketCount) === index)
                out.push({ kind: "tombstone", key });
        }
        out.sort((a, b) => a.key - b.key);
        return out;
    }
    /** All live entries (no tombstones), sorted by key ascending. */
    liveEntries() {
        return [...this.live.entries()].sort((a, b) => a[0] - b[0]);
    }
}
exports.Store = Store;
