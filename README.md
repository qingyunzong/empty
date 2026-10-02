# wxblk — append-only weather-observation block stream

Offline, single-file, append-only log for weather-station observations with
after-the-fact corrections, undoable corrections, offline verification and
time-windowed incremental decoding. Node.js 22, standard library only.

## File format

```
file   := MAGIC block*
MAGIC  := "WXBLK001"                       (8 bytes)

block  := header payload crc32c footnote
header := u8 type | u8 version | u64 id | u64 targetId | i64 timestamp
        | u32 payloadLen | 32B prevHash | 2B reserved     (64 bytes, LE)
crc32c := u32 CRC-32C over header+payload
footnote ("per-block index") := "IDX1" | u64 id | u64 offset | u64 totalLen
        | u8 type | 7B reserved | u64 targetId | i64 timestamp
        | u32 payloadLen | u32 CRC-32C of the preceding 56 bytes   (60 bytes)
```

- **Block types**: `DATA` (observation), `CORRECT` (new payload replacing
  `targetId`, which may be a DATA or CORRECT block), `UNDO` (revokes the
  CORRECT block `targetId`). Corrections never modify in place; they append a
  new block linked to the replaced one.
- **Global hash chain**: `prevHash` = SHA-256 of the previous block's 64-byte
  header (genesis = zeros). The chain protects block *structure* (order,
  identity, linkage); payload *content* is protected by the per-block CRC32C.
  A CRC-damaged block is skipped without breaking the chain; a broken chain
  fails verification.
- **Index footnotes** are a derived structure: if they are damaged, the index
  is rebuilt from a raw block scan and the differences are reported.

## Semantics

- The visible view replays history: a non-revoked CORRECT replaces its target;
  UNDO revokes a correction, exposing what it had replaced.
- `undo(correctId)` fails with `ERR_CONFLICT` while another active correction
  depends on `correctId` (i.e. targets it). Undoing twice is a no-op.
- `decode` skips CRC-bad blocks, tolerates a truncated tail (recovers the
  intact prefix deterministically), and throws `ERR_CHAIN` if the chain is
  broken. Time windows are inclusive `[start, end]` in ms; sliding the window
  gives incremental decoding.
- `verify` fails (non-zero exit) on `ERR_FORMAT`/`ERR_CHAIN`; CRC-bad blocks
  and rebuilt indexes are reported as warnings/diffs without failing.

## Errors

Errors are printed to stderr as JSON `{"error":{"code","message","details?"}}`
with a non-zero exit code: `ERR_FORMAT`=2, `ERR_CRC`=3, `ERR_CHAIN`=4,
`ERR_RANGE`=5, `ERR_CONFLICT`=6.

## CLI

```
node cli.js append  <file> --payload <str> | --payload-file <path> [--ts <ms>]
node cli.js correct <file> <id> --payload <str> | --payload-file <path> [--ts <ms>]
node cli.js undo    <file> <correctId>
node cli.js scan    <file>
node cli.js verify  <file>
node cli.js decode  <file> [--start <ms>] [--end <ms>]
```

## Library

```js
const wx = require('./src/store');
wx.append(file, payload, { timestamp });       // -> { id, offset, length }
wx.correct(file, id, newPayload, { timestamp });
wx.undo(file, correctId);
wx.scan(file);                                 // block table + errors/warnings
wx.verify(file);                               // { ok, errors, warnings, indexDiffs, index, ... }
wx.decode(file, { start, end });               // { records, truncated, skippedBlocks }
wx.computeView(blocks);                        // visible view replay
```

## Tests

```
node --test
```

See `RESULTS.md` for a captured run of the test suite and a CLI demo session.
