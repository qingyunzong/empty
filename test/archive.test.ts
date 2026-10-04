import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32, inflateRawSync } from "node:zlib";
import {
  ArchiveFormatError,
  CorruptBlockError,
  TruncatedArchiveError,
  compressArchive,
  parseArchive,
} from "../src/archive.js";

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBytes(length: number, seed: number): Buffer {
  const rand = mulberry32(seed);
  const buf = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    buf[i] = Math.floor(rand() * 256);
  }
  return buf;
}

test("round-trip: readAll returns the original bytes for many sizes", () => {
  const sizes = [0, 1, 2, 63, 64, 65, 127, 128, 129, 1000, 65536, 65537];
  for (const size of sizes) {
    const data = randomBytes(size, size * 31 + 7);
    const archive = parseArchive(compressArchive(data, { blockSize: 64 }));
    assert.equal(archive.originalSize, size, `size ${size}`);
    assert.ok(archive.readAll().equals(data), `size ${size}`);
  }
});

test("round-trip: compressible text with default block size", () => {
  const chunk = Buffer.from("the quick brown fox jumps over the lazy dog\n");
  const data = Buffer.concat(Array.from({ length: 5000 }, () => chunk));
  const archive = parseArchive(compressArchive(data));
  assert.ok(archive.blockCount > 1);
  assert.ok(archive.readAll().equals(data));
});

test("index records original length and CRC32 of every block", () => {
  const data = randomBytes(200, 42);
  const archive = parseArchive(compressArchive(data, { blockSize: 64 }));
  assert.deepEqual(
    archive.blocks.map((b) => b.originalLength),
    [64, 64, 64, 8],
  );
  let offset = 0;
  for (const block of archive.blocks) {
    const slice = data.subarray(offset, offset + block.originalLength);
    assert.equal(block.originalOffset, offset);
    assert.equal(block.crc32, crc32(slice));
    offset += block.originalLength;
  }
});

test("blocks are independently compressed (no shared dictionary)", () => {
  const data = randomBytes(500, 99);
  const packed = compressArchive(data, { blockSize: 64 });
  const archive = parseArchive(packed);
  assert.equal(archive.blockCount, 8);
  for (const block of archive.blocks) {
    const start = archive.bodyOffset + block.compressedOffset;
    const raw = inflateRawSync(
      packed.subarray(start, start + block.compressedLength),
    );
    assert.ok(
      raw.equals(
        data.subarray(
          block.originalOffset,
          block.originalOffset + block.originalLength,
        ),
      ),
      `block #${block.index} inflates standalone`,
    );
  }
});

test("all small ranges match the original byte slices", (t) => {
  const size = 1024;
  const blockSize = 128;
  const data = randomBytes(size, 1234);
  const archive = parseArchive(compressArchive(data, { blockSize }));
  const maxLength = 2 * blockSize + 1;
  const mismatches: string[] = [];
  let checked = 0;
  for (let offset = 0; offset <= size; offset++) {
    const upper = Math.min(maxLength, size - offset);
    for (let length = 0; length <= upper; length++) {
      const got = archive.readRange(offset, length);
      const want = data.subarray(offset, offset + length);
      if (!got.equals(want)) {
        mismatches.push(`offset=${offset} length=${length}`);
      }
      checked++;
    }
  }
  t.diagnostic(`checked ${checked} ranges against original slices`);
  assert.deepEqual(mismatches, []);
});

test("every possible range of a small archive matches the original", (t) => {
  const size = 200;
  const blockSize = 7; // deliberately unaligned with everything
  const data = randomBytes(size, 555);
  const archive = parseArchive(compressArchive(data, { blockSize }));
  const mismatches: string[] = [];
  let checked = 0;
  for (let offset = 0; offset <= size; offset++) {
    for (let length = 0; length <= size - offset; length++) {
      if (!archive.readRange(offset, length).equals(data.subarray(offset, offset + length))) {
        mismatches.push(`offset=${offset} length=${length}`);
      }
      checked++;
    }
  }
  t.diagnostic(`checked ${checked} ranges against original slices`);
  assert.deepEqual(mismatches, []);
});

test("range reads only decompress the hit blocks", () => {
  const size = 1024;
  const blockSize = 128;
  const data = randomBytes(size, 77);
  const packed = compressArchive(data, { blockSize });
  const archive = parseArchive(packed);

  // Corrupt block #5 (original bytes [640, 768)) inside a copy of the archive.
  const target = 5;
  const info = archive.blocks[target];
  const corrupted = Buffer.from(packed);
  for (const rel of [0, Math.floor(info.compressedLength / 2), info.compressedLength - 1]) {
    corrupted[archive.bodyOffset + info.compressedOffset + rel] ^= 0xff;
  }
  const broken = parseArchive(corrupted);

  // Ranges that do not touch block #5 still read fine, proving untouched
  // blocks are never decompressed (otherwise the corrupt block would throw).
  assert.ok(broken.readRange(0, 128).equals(data.subarray(0, 128)));
  assert.ok(broken.readRange(896, 128).equals(data.subarray(896, 1024)));
  assert.ok(broken.readRange(100, 300).equals(data.subarray(100, 400)));

  // Ranges touching block #5 throw CorruptBlockError with its original range.
  for (const [offset, length] of [[640, 1], [700, 50], [0, 1024], [767, 1]] as const) {
    assert.throws(
      () => broken.readRange(offset, length),
      (err: unknown) => {
        assert.ok(err instanceof CorruptBlockError);
        assert.equal(err.blockIndex, target);
        assert.equal(err.originalStart, 640);
        assert.equal(err.originalEnd, 768);
        return true;
      },
      `range [${offset}, ${offset + length})`,
    );
  }
});

test("corrupt block error reports the original byte range", () => {
  const data = randomBytes(300, 8);
  const packed = compressArchive(data, { blockSize: 100 });
  const archive = parseArchive(packed);
  const last = archive.blocks[2];
  const corrupted = Buffer.from(packed);
  corrupted[archive.bodyOffset + last.compressedOffset + 2] ^= 0x55;
  const broken = parseArchive(corrupted);
  assert.throws(
    () => broken.readRange(250, 10),
    (err: unknown) => {
      assert.ok(err instanceof CorruptBlockError);
      assert.equal(err.blockIndex, 2);
      assert.equal(err.originalStart, 200);
      assert.equal(err.originalEnd, 300);
      assert.match(err.message, /\[200, 300\)/);
      return true;
    },
  );
});

test("every truncation point of index and body is rejected, never partial data", (t) => {
  const data = randomBytes(640, 2024);
  const packed = compressArchive(data, { blockSize: 64 });
  const archive = parseArchive(packed);
  assert.equal(archive.blockCount, 10);

  let rejected = 0;
  for (let cut = 0; cut < packed.length; cut++) {
    try {
      parseArchive(packed.subarray(0, cut));
      assert.fail(`truncation at ${cut} bytes was accepted`);
    } catch (err) {
      assert.ok(
        err instanceof TruncatedArchiveError,
        `cut at ${cut}: expected TruncatedArchiveError, got ${String(err)}`,
      );
      rejected++;
    }
  }
  t.diagnostic(`all ${rejected} truncation points rejected`);
  assert.equal(rejected, packed.length);
});

test("index corruption is detected via CRC32", () => {
  const data = randomBytes(256, 11);
  const packed = compressArchive(data, { blockSize: 64 });
  const corrupted = Buffer.from(packed);
  corrupted[40] ^= 0x01; // inside the index region (header is 32 bytes)
  assert.throws(
    () => parseArchive(corrupted),
    (err: unknown) => {
      assert.ok(err instanceof ArchiveFormatError);
      assert.ok(!(err instanceof TruncatedArchiveError));
      assert.match(err.message, /index CRC32 mismatch/);
      return true;
    },
  );
});

test("header corruption is detected", () => {
  const data = randomBytes(256, 12);
  const packed = compressArchive(data, { blockSize: 64 });

  const badMagic = Buffer.from(packed);
  badMagic[0] ^= 0xff;
  assert.throws(() => parseArchive(badMagic), /bad magic/);

  const badCount = Buffer.from(packed);
  badCount[20] ^= 0x01; // blockCount field
  assert.throws(() => parseArchive(badCount), ArchiveFormatError);
});

test("trailing garbage after the body is rejected", () => {
  const packed = compressArchive(randomBytes(100, 3), { blockSize: 32 });
  const withGarbage = Buffer.concat([packed, Buffer.from([0x00])]);
  assert.throws(() => parseArchive(withGarbage), /trailing byte/);
});

test("readRange validates its bounds", () => {
  const archive = parseArchive(compressArchive(randomBytes(100, 5), { blockSize: 32 }));
  assert.throws(() => archive.readRange(-1, 1), RangeError);
  assert.throws(() => archive.readRange(0, 101), RangeError);
  assert.throws(() => archive.readRange(100, 1), RangeError);
  assert.throws(() => archive.readRange(1.5, 1), RangeError);
  assert.throws(() => archive.readRange(0, -1), RangeError);
  assert.equal(archive.readRange(100, 0).length, 0);
  assert.equal(archive.readRange(0, 0).length, 0);
});

test("empty input produces a valid empty archive", () => {
  const archive = parseArchive(compressArchive(Buffer.alloc(0)));
  assert.equal(archive.originalSize, 0);
  assert.equal(archive.blockCount, 0);
  assert.equal(archive.readAll().length, 0);
  assert.equal(archive.readRange(0, 0).length, 0);
  assert.throws(() => archive.readRange(0, 1), RangeError);
});

test("accepts Uint8Array input and compression level option", () => {
  const data = randomBytes(1000, 17);
  const packed = compressArchive(new Uint8Array(data), { blockSize: 128, level: 9 });
  const archive = parseArchive(packed);
  assert.ok(archive.readAll().equals(data));
});
