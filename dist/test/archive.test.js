import { test } from "node:test";
import { ok, equal, deepEqual, throws, fail } from "node:assert/strict";
import { crc32 } from "node:zlib";
import { createArchive, readRange, readAll, inspectArchive, ArchiveError, ArchiveTruncatedError, ArchiveCorruptionError, } from "../src/archive.js";
function makeInput(length) {
    const buf = Buffer.alloc(length);
    let state = 0x9e3779b9;
    for (let i = 0; i < length; i++) {
        state = (state * 1664525 + 1013904223) >>> 0;
        // Mix compressible runs with noise so deflate sees both.
        buf[i] = i % 11 < 6 ? (i >> 4) & 0xff : (state >>> 24) & 0xff;
    }
    return buf;
}
function makeRandomInput(length, seed) {
    const buf = Buffer.alloc(length);
    let state = seed >>> 0;
    for (let i = 0; i < length; i++) {
        state = (state * 1664525 + 1013904223) >>> 0;
        buf[i] = (state >>> 24) & 0xff;
    }
    return buf;
}
function catchThrown(fn) {
    try {
        fn();
    }
    catch (err) {
        return err;
    }
    fail("expected function to throw");
}
test("round-trip: readAll returns the original bytes for many sizes", () => {
    const sizes = [0, 1, 15, 16, 17, 63, 64, 65, 1000, 65536, 200000];
    for (const size of sizes) {
        const input = makeInput(size);
        const archive = createArchive(input, 64);
        const out = readAll(archive);
        ok(out.equals(input), `round-trip failed for size ${size}`);
    }
    // Also with the default (64 KiB) block size.
    const big = makeInput(200000);
    ok(readAll(createArchive(big)).equals(big));
});
test("round-trip: incompressible random data", () => {
    const input = makeRandomInput(5000, 12345);
    const archive = createArchive(input, 64);
    ok(readAll(archive).equals(input));
});
test("exhaustive small ranges match the original byte slices", () => {
    const input = makeInput(96);
    const archive = createArchive(input, 16);
    let checked = 0;
    for (let start = 0; start <= input.length; start++) {
        for (let len = 0; len <= input.length - start; len++) {
            const got = readRange(archive, start, len);
            const want = input.subarray(start, start + len);
            ok(got.equals(want), `range [${start}, ${start + len}) mismatch`);
            checked++;
        }
    }
    equal(checked, (97 * 98) / 2);
});
test("random cross-block ranges match the original byte slices", () => {
    const input = makeInput(5000);
    const archive = createArchive(input, 100);
    let state = 777;
    const next = () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state;
    };
    for (let i = 0; i < 2000; i++) {
        const start = next() % (input.length + 1);
        const len = next() % (input.length + 1 - start);
        const got = readRange(archive, start, len);
        ok(got.equals(input.subarray(start, start + len)), `range [${start}, ${start + len}) mismatch`);
    }
});
test("index records original offset, length and CRC of every block", () => {
    const input = makeInput(100);
    const blockSize = 32;
    const archive = createArchive(input, blockSize);
    const info = inspectArchive(archive);
    equal(info.blockSize, blockSize);
    equal(info.totalLength, input.length);
    equal(info.blocks.length, 4);
    let offset = 0;
    for (const block of info.blocks) {
        const slice = input.subarray(offset, Math.min(offset + blockSize, input.length));
        equal(block.originalOffset, offset);
        equal(block.originalLength, slice.length);
        equal(block.crc, crc32(slice));
        offset += slice.length;
    }
});
test("range reads only decompress the blocks they hit", () => {
    const blockSize = 16;
    const input = makeInput(blockSize * 4);
    const archive = Buffer.from(createArchive(input, blockSize));
    const info = inspectArchive(archive);
    // Corrupt one byte inside block 2's compressed data.
    const victim = info.blocks[2];
    const corruptAt = info.bodyStart + victim.compressedOffset;
    archive[corruptAt] = archive[corruptAt] ^ 0xff;
    // Ranges touching only intact blocks still read correctly.
    ok(readRange(archive, 0, blockSize).equals(input.subarray(0, blockSize)));
    ok(readRange(archive, 3 * blockSize, blockSize).equals(input.subarray(3 * blockSize)));
    ok(readRange(archive, 3, 5).equals(input.subarray(3, 8)));
    // Ranges touching the corrupt block fail.
    throws(() => readRange(archive, 2 * blockSize, 1), ArchiveCorruptionError);
    throws(() => readRange(archive, blockSize, 2 * blockSize), ArchiveCorruptionError);
    throws(() => readAll(archive), ArchiveCorruptionError);
});
test("corrupt block reports its original (uncompressed) byte interval", () => {
    const blockSize = 16;
    const input = makeInput(50); // blocks: [0,16) [16,32) [32,48) [48,50)
    const archive = Buffer.from(createArchive(input, blockSize));
    const info = inspectArchive(archive);
    const last = info.blocks[3];
    const corruptAt = info.bodyStart + last.compressedOffset;
    archive[corruptAt] = archive[corruptAt] ^ 0xff;
    const err = catchThrown(() => readRange(archive, 40, 10));
    ok(err instanceof ArchiveCorruptionError);
    const corruption = err;
    equal(corruption.originalStart, 48);
    equal(corruption.originalEnd, 50);
});
test("corruption is detected via CRC even when inflation succeeds", () => {
    // Two equal-length blocks that compress to equal-length payloads. Swapping
    // the payloads keeps every deflate stream valid, so only the stored CRC can
    // catch the corruption.
    const blockSize = 16;
    const input = Buffer.concat([Buffer.alloc(blockSize, 0xaa), Buffer.alloc(blockSize, 0xbb)]);
    const archive = Buffer.from(createArchive(input, blockSize));
    const info = inspectArchive(archive);
    const [a, b] = info.blocks;
    equal(a.compressedLength, b.compressedLength);
    const aStart = info.bodyStart + a.compressedOffset;
    const bStart = info.bodyStart + b.compressedOffset;
    const tmp = Buffer.from(archive.subarray(aStart, aStart + a.compressedLength));
    archive.set(archive.subarray(bStart, bStart + b.compressedLength), aStart);
    archive.set(tmp, bStart);
    const err = catchThrown(() => readAll(archive));
    ok(err instanceof ArchiveCorruptionError);
    const corruption = err;
    equal(corruption.originalStart, 0);
    equal(corruption.originalEnd, blockSize);
});
test("no truncation ever yields pseudo-complete data", () => {
    const input = makeInput(200);
    const archive = createArchive(input, 32);
    ok(readAll(archive).equals(input));
    for (let cut = 0; cut < archive.length; cut++) {
        const truncated = archive.subarray(0, cut);
        const errAll = catchThrown(() => readAll(truncated));
        ok(errAll instanceof ArchiveError, `cut at ${cut}: readAll did not fail with ArchiveError`);
        const errRange = catchThrown(() => readRange(truncated, 0, 1));
        ok(errRange instanceof ArchiveError, `cut at ${cut}: readRange did not fail with ArchiveError`);
    }
});
test("truncated header, index and body raise ArchiveTruncatedError", () => {
    const input = makeInput(200);
    const archive = createArchive(input, 32);
    const info = inspectArchive(archive);
    throws(() => readAll(archive.subarray(0, 10)), ArchiveTruncatedError); // inside header
    throws(() => readAll(archive.subarray(0, 28 + 5)), ArchiveTruncatedError); // inside index
    throws(() => readAll(archive.subarray(0, info.bodyStart + 2)), ArchiveTruncatedError); // inside index crc / body
    throws(() => readAll(archive.subarray(0, archive.length - 1)), ArchiveTruncatedError); // body short by 1
});
test("tampered header and index are rejected", () => {
    const input = makeInput(100);
    const good = createArchive(input, 32);
    const badHeader = Buffer.from(good);
    badHeader[8] = badHeader[8] ^ 0x01; // blockSize field
    throws(() => readAll(badHeader), ArchiveCorruptionError);
    const badIndex = Buffer.from(good);
    badIndex[28 + 9] = badIndex[28 + 9] ^ 0x01; // inside first index entry
    throws(() => readAll(badIndex), ArchiveCorruptionError);
    const badMagic = Buffer.from(good);
    badMagic[0] = badMagic[0] ^ 0x01;
    throws(() => readAll(badMagic), ArchiveCorruptionError);
});
test("range argument validation", () => {
    const input = makeInput(50);
    const archive = createArchive(input, 16);
    throws(() => readRange(archive, -1, 1), RangeError);
    throws(() => readRange(archive, 0, -1), RangeError);
    throws(() => readRange(archive, 0, 51), RangeError);
    throws(() => readRange(archive, 50, 1), RangeError);
    throws(() => readRange(archive, 1.5, 1), RangeError);
    equal(readRange(archive, 50, 0).length, 0);
    equal(readRange(archive, 0, 0).length, 0);
});
test("empty input archives and reads back as empty", () => {
    const archive = createArchive(Buffer.alloc(0));
    const info = inspectArchive(archive);
    equal(info.totalLength, 0);
    equal(info.blocks.length, 0);
    equal(readAll(archive).length, 0);
    equal(readRange(archive, 0, 0).length, 0);
    throws(() => readRange(archive, 0, 1), RangeError);
});
test("archive creation is deterministic", () => {
    const input = makeInput(1000);
    ok(createArchive(input, 64).equals(createArchive(input, 64)));
});
test("invalid block size is rejected", () => {
    const input = makeInput(10);
    throws(() => createArchive(input, 0), RangeError);
    throws(() => createArchive(input, -5), RangeError);
    throws(() => createArchive(input, 1.5), RangeError);
});
test("deepEqual sanity: buffers compare by content", () => {
    const input = makeInput(40);
    const archive = createArchive(input, 8);
    deepEqual([...readRange(archive, 5, 20)], [...input.subarray(5, 25)]);
});
