"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SyncServer = exports.VersionMismatchError = void 0;
const store_1 = require("./store");
const digest_1 = require("./digest");
class VersionMismatchError extends Error {
    expected;
    actual;
    constructor(expected, actual) {
        super(`source version changed: expected ${expected}, actual ${actual}`);
        this.expected = expected;
        this.actual = actual;
        this.name = "VersionMismatchError";
    }
}
exports.VersionMismatchError = VersionMismatchError;
/**
 * Read side of the sync protocol. Every request is pinned to a source
 * version observed by the client; if the store has moved on, the request
 * is rejected with VersionMismatchError so the client retries the round.
 */
class SyncServer {
    store;
    hashFn;
    bucketCount;
    constructor(store, hashFn = digest_1.sha256, bucketCount = store_1.BUCKET_COUNT) {
        this.store = store;
        this.hashFn = hashFn;
        this.bucketCount = bucketCount;
    }
    get version() {
        return this.store.version;
    }
    digests(expectedVersion) {
        this.assertVersion(expectedVersion);
        return (0, digest_1.digestsFor)(this.store, this.hashFn, this.bucketCount);
    }
    bucketEntries(index, expectedVersion) {
        this.assertVersion(expectedVersion);
        return this.store.entriesInBucket(index, this.bucketCount).map((entry) => entry.kind === "live" ? { kind: "live", key: entry.key, value: entry.value.slice() } : entry);
    }
    allLiveEntries(expectedVersion) {
        this.assertVersion(expectedVersion);
        return this.store.liveEntries().map(([key, value]) => [key, value.slice()]);
    }
    assertVersion(expected) {
        if (this.store.version !== expected) {
            throw new VersionMismatchError(expected, this.store.version);
        }
    }
}
exports.SyncServer = SyncServer;
