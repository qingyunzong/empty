# chunked-archive

Chunked compression archive library in TypeScript, using only Node.js
built-ins (`node:zlib`, `node:test`, `node:assert`). Input is compressed as
independent deflate blocks; an index records each block's original offset,
original length and CRC-32. Range reads span block boundaries but only
decompress the blocks they hit. Corrupt blocks are reported with their
original (uncompressed) byte interval, and truncated indexes or bodies never
return pseudo-complete data — every read validates the whole index and body
extents up front and throws instead.

## Archive format (all integers little-endian)

```
Header (28 bytes)
  0  u32  magic "CBAR"
  4  u16  version = 1
  6  u16  flags = 0
  8  u32  blockSize
  12 u64  totalLength (original bytes)
  20 u32  blockCount
  24 u32  CRC-32 of header bytes 0..23

Index (blockCount * 32 bytes), then u32 CRC-32 of the whole index
  per entry:
  0  u64  originalOffset
  8  u32  originalLength
  12 u32  CRC-32 of the original block bytes
  16 u64  compressedOffset (relative to body start)
  24 u32  compressedLength
  28 u32  reserved = 0

Body: concatenated deflate-raw compressed blocks
```

## API (`src/archive.ts`)

- `createArchive(input: Buffer, blockSize = 65536): Buffer`
- `readRange(archive: Buffer, start: number, length: number): Buffer` —
  decompresses only the blocks overlapping `[start, start + length)`
- `readAll(archive: Buffer): Buffer`
- `inspectArchive(archive: Buffer): ArchiveInfo` — parsed header + index
- Errors: `ArchiveTruncatedError` (header/index/body cut short),
  `ArchiveCorruptionError` (bad magic/CRC/inconsistent index; carries
  `originalStart`/`originalEnd` when a specific block is bad),
  `RangeError` (invalid range arguments)

## Build and test

`npm test` compiles with `tsc` and runs the suite with `node --test`:

```
npm test        # tsc -p tsconfig.json && node --test dist/test/*.test.js
```

No dependencies to install; the sandbox has no network access, so Node
built-in types are provided by the local shim `types/node-shims.d.ts`.

## Test results (recorded 2026-10-05, Node v22.22.1, tsc 7.0.2)

`npm test` exits 0; all 16 tests pass:

```
ok 1 - round-trip: readAll returns the original bytes for many sizes
ok 2 - round-trip: incompressible random data
ok 3 - exhaustive small ranges match the original byte slices
ok 4 - random cross-block ranges match the original byte slices
ok 5 - index records original offset, length and CRC of every block
ok 6 - range reads only decompress the blocks they hit
ok 7 - corrupt block reports its original (uncompressed) byte interval
ok 8 - corruption is detected via CRC even when inflation succeeds
ok 9 - no truncation ever yields pseudo-complete data
ok 10 - truncated header, index and body raise ArchiveTruncatedError
ok 11 - tampered header and index are rejected
ok 12 - range argument validation
ok 13 - empty input archives and reads back as empty
ok 14 - archive creation is deterministic
ok 15 - invalid block size is rejected
ok 16 - deepEqual sanity: buffers compare by content
# tests 16  # pass 16  # fail 0
```

Notable coverage:

- Test 3 checks **every** range `[start, start+len)` of a 96-byte input
  (4753 ranges) against the original byte slices.
- Test 9 truncates a valid archive at **every** byte offset and asserts each
  prefix fails with an `ArchiveError` instead of returning partial data.
- Test 6 corrupts one block's compressed bytes and proves untouched blocks
  still serve range reads while overlapping ranges throw.
- Test 8 swaps two valid compressed payloads so inflation succeeds and only
  the stored CRC-32 detects the corruption.
