"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.entriesBytesEqual = entriesBytesEqual;
exports.syncStore = syncStore;
exports.verifyFullSet = verifyFullSet;
const digest_1 = require("./digest");
const server_1 = require("./server");
function bytesEqual(a, b) {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i])
            return false;
    }
    return true;
}
/** Replace a destination bucket with the source's entries for that bucket. */
function replaceBucket(dest, index, entries, bucketCount) {
    const remoteKeys = new Set(entries.map((entry) => entry.key));
    for (const local of dest.entriesInBucket(index, bucketCount)) {
        if (!remoteKeys.has(local.key))
            dest.purge(local.key);
    }
    for (const entry of entries)
        dest.apply(entry);
}
/** Record-by-record, byte-by-byte confirmation of two sorted entry lists. */
function entriesBytesEqual(a, b) {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++) {
        const left = a[i];
        const right = b[i];
        if (left.kind !== right.kind || left.key !== right.key)
            return false;
        if (left.kind === "live" && right.kind === "live" && !bytesEqual(left.value, right.value)) {
            return false;
        }
    }
    return true;
}
/**
 * Reconcile `dest` with the source behind `server`. The whole round is
 * pinned to the source version observed at round start; any version drift
 * (reported by the server or caught by the end-of-round barrier) retries
 * the round from scratch.
 */
function syncStore(dest, server, options = {}) {
    const hashFn = options.hashFn ?? server.hashFn;
    const bucketCount = options.bucketCount ?? server.bucketCount;
    const byteVerify = options.byteVerify ?? false;
    const maxRetries = options.maxRetries ?? 8;
    const stats = {
        rounds: 0,
        retries: 0,
        fetchedBuckets: [],
        byteCheckedBuckets: 0,
        byteMismatchedBuckets: [],
    };
    for (let attempt = 0;; attempt++) {
        try {
            stats.rounds++;
            const version = server.version;
            const remote = server.digests(version);
            const local = (0, digest_1.digestsFor)(dest, hashFn, bucketCount);
            const differing = [];
            for (let index = 0; index < bucketCount; index++) {
                if (!(0, digest_1.sameDigest)(remote[index], local[index]))
                    differing.push(index);
            }
            // Only differing buckets are fetched; each fetched bucket's content is
            // replaced wholesale with the source's (extras purged, not just merged).
            for (const index of differing) {
                const entries = server.bucketEntries(index, version);
                replaceBucket(dest, index, entries, bucketCount);
            }
            stats.fetchedBuckets.push(...differing);
            if (byteVerify) {
                const skipped = new Set(differing);
                for (let index = 0; index < bucketCount; index++) {
                    if (skipped.has(index))
                        continue;
                    stats.byteCheckedBuckets++;
                    const remoteEntries = server.bucketEntries(index, version);
                    const localEntries = dest.entriesInBucket(index, bucketCount);
                    if (!entriesBytesEqual(localEntries, remoteEntries)) {
                        stats.byteMismatchedBuckets.push(index);
                        replaceBucket(dest, index, remoteEntries, bucketCount);
                    }
                }
            }
            // End-of-round barrier: the source must not have moved mid-round.
            if (server.version !== version) {
                throw new server_1.VersionMismatchError(version, server.version);
            }
            return stats;
        }
        catch (error) {
            if (error instanceof server_1.VersionMismatchError && attempt < maxRetries) {
                stats.retries++;
                continue;
            }
            throw error;
        }
    }
}
/** Final verification: compare the destination against the full source set. */
function verifyFullSet(dest, server) {
    const remote = server.allLiveEntries(server.version);
    const local = dest.liveEntries();
    if (remote.length !== local.length)
        return false;
    for (let i = 0; i < remote.length; i++) {
        const [remoteKey, remoteValue] = remote[i];
        const [localKey, localValue] = local[i];
        if (remoteKey !== localKey || !bytesEqual(remoteValue, localValue))
            return false;
    }
    return true;
}
