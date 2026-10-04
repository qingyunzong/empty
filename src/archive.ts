import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

const MAGIC = Buffer.from("BZAR", "ascii");
const VERSION = 1;
const HEADER_LENGTH = 32;
const INDEX_ENTRY_LENGTH = 12;
const DEFAULT_BLOCK_SIZE = 64 * 1024;

export class ArchiveFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveFormatError";
  }
}

export class TruncatedArchiveError extends ArchiveFormatError {
  readonly section: string;

  constructor(section: string, expectedLength: number, actualLength: number) {
    super(
      `archive ${section} truncated: need ${expectedLength} bytes, have ${actualLength}`,
    );
    this.name = "TruncatedArchiveError";
    this.section = section;
  }
}

export class CorruptBlockError extends Error {
  readonly blockIndex: number;
  readonly originalStart: number;
  readonly originalEnd: number;

  constructor(
    blockIndex: number,
    originalStart: number,
    originalEnd: number,
    options?: { cause?: unknown },
  ) {
    super(
      `corrupt block #${blockIndex}: original byte range [${originalStart}, ${originalEnd})`,
      options,
    );
    this.name = "CorruptBlockError";
    this.blockIndex = blockIndex;
    this.originalStart = originalStart;
    this.originalEnd = originalEnd;
  }
}

export interface BlockInfo {
  readonly index: number;
  readonly originalOffset: number;
  readonly originalLength: number;
  readonly compressedOffset: number;
  readonly compressedLength: number;
  readonly crc32: number;
}

export interface CompressOptions {
  blockSize?: number;
  level?: number;
}

export function compressArchive(
  data: Buffer | Uint8Array,
  options: CompressOptions = {},
): Buffer {
  const blockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE;
  if (!Number.isInteger(blockSize) || blockSize < 1) {
    throw new RangeError(`blockSize must be a positive integer, got ${blockSize}`);
  }
  const level = options.level ?? 6;
  const input = Buffer.isBuffer(data) ? data : Buffer.from(data);

  const blockCount = Math.ceil(input.length / blockSize);
  const index = Buffer.alloc(blockCount * INDEX_ENTRY_LENGTH);
  const bodies: Buffer[] = [];

  for (let i = 0; i < blockCount; i++) {
    const chunk = input.subarray(i * blockSize, (i + 1) * blockSize);
    const compressed = deflateRawSync(chunk, { level });
    const base = i * INDEX_ENTRY_LENGTH;
    index.writeUInt32LE(chunk.length, base);
    index.writeUInt32LE(compressed.length, base + 4);
    index.writeUInt32LE(crc32(chunk), base + 8);
    bodies.push(compressed);
  }

  const header = Buffer.alloc(HEADER_LENGTH);
  MAGIC.copy(header, 0);
  header.writeUInt16LE(VERSION, 4);
  header.writeUInt16LE(HEADER_LENGTH, 6);
  header.writeUInt32LE(blockSize, 8);
  header.writeBigUInt64LE(BigInt(input.length), 12);
  header.writeUInt32LE(blockCount, 20);
  header.writeUInt32LE(index.length, 24);
  header.writeUInt32LE(crc32(index), 28);

  return Buffer.concat([header, index, ...bodies]);
}

export class Archive {
  readonly blockSize: number;
  readonly originalSize: number;
  readonly blocks: readonly BlockInfo[];
  readonly bodyOffset: number;
  private readonly buffer: Buffer;

  private constructor(
    buffer: Buffer,
    blockSize: number,
    originalSize: number,
    blocks: BlockInfo[],
    bodyOffset: number,
  ) {
    this.buffer = buffer;
    this.blockSize = blockSize;
    this.originalSize = originalSize;
    this.blocks = blocks;
    this.bodyOffset = bodyOffset;
  }

  get blockCount(): number {
    return this.blocks.length;
  }

  static parse(input: Buffer | Uint8Array): Archive {
    const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);

    if (buffer.length < HEADER_LENGTH) {
      throw new TruncatedArchiveError("header", HEADER_LENGTH, buffer.length);
    }
    if (!buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new ArchiveFormatError("bad magic bytes");
    }
    const version = buffer.readUInt16LE(4);
    if (version !== VERSION) {
      throw new ArchiveFormatError(`unsupported version ${version}`);
    }
    const headerLength = buffer.readUInt16LE(6);
    if (headerLength !== HEADER_LENGTH) {
      throw new ArchiveFormatError(`unexpected header length ${headerLength}`);
    }
    const blockSize = buffer.readUInt32LE(8);
    const originalSizeBig = buffer.readBigUInt64LE(12);
    if (originalSizeBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ArchiveFormatError("original size exceeds safe integer range");
    }
    const originalSize = Number(originalSizeBig);
    const blockCount = buffer.readUInt32LE(20);
    const indexLength = buffer.readUInt32LE(24);
    const indexCrc = buffer.readUInt32LE(28);

    if (blockCount > 0 && blockSize < 1) {
      throw new ArchiveFormatError("invalid block size in header");
    }
    if (indexLength !== blockCount * INDEX_ENTRY_LENGTH) {
      throw new ArchiveFormatError(
        `index length ${indexLength} does not match block count ${blockCount}`,
      );
    }
    if (buffer.length < HEADER_LENGTH + indexLength) {
      throw new TruncatedArchiveError(
        "index",
        HEADER_LENGTH + indexLength,
        buffer.length,
      );
    }
    const indexBytes = buffer.subarray(HEADER_LENGTH, HEADER_LENGTH + indexLength);
    if (crc32(indexBytes) !== indexCrc) {
      throw new ArchiveFormatError("index CRC32 mismatch");
    }

    const blocks: BlockInfo[] = [];
    let originalOffset = 0;
    let compressedOffset = 0;
    for (let i = 0; i < blockCount; i++) {
      const base = i * INDEX_ENTRY_LENGTH;
      const originalLength = indexBytes.readUInt32LE(base);
      const compressedLength = indexBytes.readUInt32LE(base + 4);
      const blockCrc = indexBytes.readUInt32LE(base + 8);
      if (originalLength > blockSize) {
        throw new ArchiveFormatError(
          `block #${i} original length ${originalLength} exceeds block size ${blockSize}`,
        );
      }
      if (i < blockCount - 1 && originalLength !== blockSize) {
        throw new ArchiveFormatError(
          `non-final block #${i} has original length ${originalLength}, expected ${blockSize}`,
        );
      }
      blocks.push({
        index: i,
        originalOffset,
        originalLength,
        compressedOffset,
        compressedLength,
        crc32: blockCrc,
      });
      originalOffset += originalLength;
      compressedOffset += compressedLength;
    }

    if (originalOffset !== originalSize) {
      throw new ArchiveFormatError(
        `index original lengths sum to ${originalOffset}, header says ${originalSize}`,
      );
    }

    const bodyOffset = HEADER_LENGTH + indexLength;
    const bodyLength = buffer.length - bodyOffset;
    if (bodyLength < compressedOffset) {
      throw new TruncatedArchiveError(
        "body",
        bodyOffset + compressedOffset,
        buffer.length,
      );
    }
    if (bodyLength > compressedOffset) {
      throw new ArchiveFormatError(
        `${bodyLength - compressedOffset} trailing byte(s) after body`,
      );
    }

    return new Archive(buffer, blockSize, originalSize, blocks, bodyOffset);
  }

  readAll(): Buffer {
    return this.readRange(0, this.originalSize);
  }

  readRange(offset: number, length: number): Buffer {
    if (!Number.isInteger(offset) || !Number.isInteger(length)) {
      throw new RangeError("offset and length must be integers");
    }
    if (offset < 0 || length < 0 || offset + length > this.originalSize) {
      throw new RangeError(
        `range [${offset}, ${offset + length}) out of bounds for size ${this.originalSize}`,
      );
    }
    if (length === 0) {
      return Buffer.alloc(0);
    }

    const end = offset + length;
    const parts: Buffer[] = [];
    let firstBlockOffset = -1;
    for (const block of this.blocks) {
      const blockEnd = block.originalOffset + block.originalLength;
      if (blockEnd <= offset) continue;
      if (block.originalOffset >= end) break;
      if (firstBlockOffset < 0) firstBlockOffset = block.originalOffset;
      parts.push(this.inflateBlock(block.index));
    }

    const joined = parts.length === 1 ? parts[0] : Buffer.concat(parts);
    const sliceStart = offset - firstBlockOffset;
    return joined.subarray(sliceStart, sliceStart + length);
  }

  private inflateBlock(index: number): Buffer {
    const block = this.blocks[index];
    const start = this.bodyOffset + block.compressedOffset;
    const compressed = this.buffer.subarray(start, start + block.compressedLength);
    let raw: Buffer;
    try {
      raw = inflateRawSync(compressed);
    } catch (cause) {
      throw new CorruptBlockError(
        block.index,
        block.originalOffset,
        block.originalOffset + block.originalLength,
        { cause },
      );
    }
    if (raw.length !== block.originalLength || crc32(raw) !== block.crc32) {
      throw new CorruptBlockError(
        block.index,
        block.originalOffset,
        block.originalOffset + block.originalLength,
      );
    }
    return raw;
  }
}

export function parseArchive(input: Buffer | Uint8Array): Archive {
  return Archive.parse(input);
}
