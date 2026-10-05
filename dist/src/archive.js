import { deflateRawSync, inflateRawSync, crc32 } from "node:zlib";
export const DEFAULT_BLOCK_SIZE = 64 * 1024;
const MAGIC = 0x52414243; // "CBAR"
const VERSION = 1;
const HEADER_SIZE = 28;
const HEADER_CRC_OFFSET = 24;
const INDEX_ENTRY_SIZE = 32;
const INDEX_CRC_SIZE = 4;
export class ArchiveError extends Error {
    constructor(message) {
        super(message);
        this.name = "ArchiveError";
    }
}
export class ArchiveTruncatedError extends ArchiveError {
    constructor(message) {
        super(message);
        this.name = "ArchiveTruncatedError";
    }
}
export class ArchiveCorruptionError extends ArchiveError {
    originalStart;
    originalEnd;
    constructor(message, originalStart, originalEnd) {
        super(message);
        this.name = "ArchiveCorruptionError";
        this.originalStart = originalStart;
        this.originalEnd = originalEnd;
    }
}
export function createArchive(input, blockSize = DEFAULT_BLOCK_SIZE) {
    if (!Number.isSafeInteger(blockSize) || blockSize <= 0) {
        throw new RangeError(`blockSize must be a positive safe integer, got ${blockSize}`);
    }
    const totalLength = input.length;
    const blockCount = totalLength === 0 ? 0 : Math.ceil(totalLength / blockSize);
    const entries = [];
    const chunks = [];
    let bodyOffset = 0;
    for (let i = 0; i < blockCount; i++) {
        const start = i * blockSize;
        const block = input.subarray(start, Math.min(start + blockSize, totalLength));
        const compressed = deflateRawSync(block, { level: 9 });
        const entry = Buffer.alloc(INDEX_ENTRY_SIZE);
        entry.writeBigUInt64LE(BigInt(start), 0);
        entry.writeUInt32LE(block.length, 8);
        entry.writeUInt32LE(crc32(block), 12);
        entry.writeBigUInt64LE(BigInt(bodyOffset), 16);
        entry.writeUInt32LE(compressed.length, 24);
        entry.writeUInt32LE(0, 28);
        entries.push(entry);
        chunks.push(compressed);
        bodyOffset += compressed.length;
    }
    const index = Buffer.concat(entries);
    const header = Buffer.alloc(HEADER_SIZE);
    header.writeUInt32LE(MAGIC, 0);
    header.writeUInt16LE(VERSION, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt32LE(blockSize, 8);
    header.writeBigUInt64LE(BigInt(totalLength), 12);
    header.writeUInt32LE(blockCount, 20);
    header.writeUInt32LE(crc32(header.subarray(0, HEADER_CRC_OFFSET)), HEADER_CRC_OFFSET);
    const indexCrc = Buffer.alloc(INDEX_CRC_SIZE);
    indexCrc.writeUInt32LE(crc32(index), 0);
    return Buffer.concat([header, index, indexCrc, ...chunks]);
}
function parseArchive(archive) {
    if (archive.length < HEADER_SIZE) {
        throw new ArchiveTruncatedError(`header truncated: need ${HEADER_SIZE} bytes, got ${archive.length}`);
    }
    if (archive.readUInt32LE(0) !== MAGIC) {
        throw new ArchiveCorruptionError("bad magic bytes");
    }
    const version = archive.readUInt16LE(4);
    if (version !== VERSION) {
        throw new ArchiveError(`unsupported archive version ${version}`);
    }
    if (crc32(archive.subarray(0, HEADER_CRC_OFFSET)) !== archive.readUInt32LE(HEADER_CRC_OFFSET)) {
        throw new ArchiveCorruptionError("header CRC mismatch");
    }
    const blockSize = archive.readUInt32LE(8);
    if (blockSize === 0) {
        throw new ArchiveCorruptionError("block size is zero");
    }
    const totalLength = Number(archive.readBigUInt64LE(12));
    if (!Number.isSafeInteger(totalLength)) {
        throw new ArchiveCorruptionError("total length exceeds safe integer range");
    }
    const blockCount = archive.readUInt32LE(20);
    const expectedBlocks = totalLength === 0 ? 0 : Math.ceil(totalLength / blockSize);
    if (blockCount !== expectedBlocks) {
        throw new ArchiveCorruptionError(`block count ${blockCount} inconsistent with total length ${totalLength} and block size ${blockSize}`);
    }
    const indexStart = HEADER_SIZE;
    const indexEnd = indexStart + blockCount * INDEX_ENTRY_SIZE;
    if (archive.length < indexEnd + INDEX_CRC_SIZE) {
        throw new ArchiveTruncatedError(`index truncated: need ${indexEnd + INDEX_CRC_SIZE} bytes, got ${archive.length}`);
    }
    if (crc32(archive.subarray(indexStart, indexEnd)) !== archive.readUInt32LE(indexEnd)) {
        throw new ArchiveCorruptionError("index CRC mismatch");
    }
    const bodyStart = indexEnd + INDEX_CRC_SIZE;
    const bodyLength = archive.length - bodyStart;
    const blocks = [];
    let expectedOriginal = 0;
    let expectedCompressed = 0;
    for (let i = 0; i < blockCount; i++) {
        const off = indexStart + i * INDEX_ENTRY_SIZE;
        const entry = {
            originalOffset: Number(archive.readBigUInt64LE(off)),
            originalLength: archive.readUInt32LE(off + 8),
            crc: archive.readUInt32LE(off + 12),
            compressedOffset: Number(archive.readBigUInt64LE(off + 16)),
            compressedLength: archive.readUInt32LE(off + 24),
        };
        if (entry.originalOffset !== expectedOriginal) {
            throw new ArchiveCorruptionError(`block ${i}: original offset gap or overlap`);
        }
        if (entry.originalLength === 0 || entry.originalLength > blockSize) {
            throw new ArchiveCorruptionError(`block ${i}: invalid original length ${entry.originalLength}`);
        }
        if (entry.compressedOffset !== expectedCompressed) {
            throw new ArchiveCorruptionError(`block ${i}: compressed offset gap or overlap`);
        }
        if (entry.compressedOffset + entry.compressedLength > bodyLength) {
            throw new ArchiveTruncatedError(`block ${i}: compressed data truncated (need body bytes ${entry.compressedOffset}..${entry.compressedOffset + entry.compressedLength}, body has ${bodyLength})`);
        }
        blocks.push(entry);
        expectedOriginal += entry.originalLength;
        expectedCompressed += entry.compressedLength;
    }
    if (expectedOriginal !== totalLength) {
        throw new ArchiveCorruptionError("index original lengths do not sum to total length");
    }
    return { blockSize, totalLength, blocks, bodyStart, bodyLength };
}
export function inspectArchive(archive) {
    return parseArchive(archive);
}
function inflateBlock(archive, info, block) {
    const absStart = info.bodyStart + block.compressedOffset;
    const compressed = archive.subarray(absStart, absStart + block.compressedLength);
    const rangeStart = block.originalOffset;
    const rangeEnd = block.originalOffset + block.originalLength;
    let raw;
    try {
        raw = inflateRawSync(compressed);
    }
    catch {
        throw new ArchiveCorruptionError(`block at original range [${rangeStart}, ${rangeEnd}) failed to decompress`, rangeStart, rangeEnd);
    }
    if (raw.length !== block.originalLength || crc32(raw) !== block.crc) {
        throw new ArchiveCorruptionError(`checksum mismatch for block at original range [${rangeStart}, ${rangeEnd})`, rangeStart, rangeEnd);
    }
    return raw;
}
export function readRange(archive, start, length) {
    const info = parseArchive(archive);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0) {
        throw new RangeError(`start and length must be non-negative safe integers, got [${start}, ${length})`);
    }
    if (start + length > info.totalLength) {
        throw new RangeError(`range [${start}, ${start + length}) exceeds total length ${info.totalLength}`);
    }
    if (length === 0) {
        return Buffer.alloc(0);
    }
    const end = start + length;
    const parts = [];
    for (const block of info.blocks) {
        const blockEnd = block.originalOffset + block.originalLength;
        if (blockEnd <= start)
            continue;
        if (block.originalOffset >= end)
            break;
        const raw = inflateBlock(archive, info, block);
        const sliceStart = Math.max(start - block.originalOffset, 0);
        const sliceEnd = Math.min(end - block.originalOffset, block.originalLength);
        parts.push(raw.subarray(sliceStart, sliceEnd));
    }
    return Buffer.concat(parts);
}
export function readAll(archive) {
    const info = parseArchive(archive);
    return readRange(archive, 0, info.totalLength);
}
