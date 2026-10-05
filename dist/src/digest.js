"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sha256 = void 0;
exports.digestOf = digestOf;
exports.digestsFor = digestsFor;
exports.sameDigest = sameDigest;
const node_crypto_1 = require("node:crypto");
const store_1 = require("./store");
const sha256 = (data) => (0, node_crypto_1.createHash)("sha256").update(data).digest();
exports.sha256 = sha256;
function serializeBucket(index, entries) {
    let size = 8;
    for (const entry of entries) {
        size += 8 + 1 + (entry.kind === "live" ? 4 + entry.value.length : 0);
    }
    const buffer = new ArrayBuffer(size);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    let offset = 0;
    view.setBigInt64(offset, BigInt(index));
    offset += 8;
    for (const entry of entries) {
        view.setBigInt64(offset, BigInt(entry.key));
        offset += 8;
        view.setUint8(offset, entry.kind === "live" ? 1 : 0);
        offset += 1;
        if (entry.kind === "live") {
            view.setUint32(offset, entry.value.length);
            offset += 4;
            bytes.set(entry.value, offset);
            offset += entry.value.length;
        }
    }
    return bytes;
}
function toHex(bytes) {
    let out = "";
    for (const byte of bytes)
        out += byte.toString(16).padStart(2, "0");
    return out;
}
/**
 * Digest of one bucket. Tombstones are serialized into the hash and counted
 * separately, so a bucket holding only tombstones differs from a bucket that
 * has always been empty.
 */
function digestOf(index, entries, hashFn) {
    let live = 0;
    let tombstones = 0;
    for (const entry of entries) {
        if (entry.kind === "live")
            live++;
        else
            tombstones++;
    }
    return {
        index,
        live,
        tombstones,
        hash: toHex(hashFn(serializeBucket(index, entries))),
    };
}
function digestsFor(store, hashFn, bucketCount = store_1.BUCKET_COUNT) {
    const out = [];
    for (let index = 0; index < bucketCount; index++) {
        out.push(digestOf(index, store.entriesInBucket(index, bucketCount), hashFn));
    }
    return out;
}
function sameDigest(a, b) {
    return a.hash === b.hash && a.live === b.live && a.tombstones === b.tombstones;
}
