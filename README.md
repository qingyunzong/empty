# devlog

Offline, append-only device event log for Node.js 22. Standard library only
(`node:fs`, `node:crypto`, `node:test`). Events are immutable: corrections and
revocations are appended as new records, never edited in place.

## File format

```
[file magic "DLOG0001"]
[block]*            u32 "BLK1" | u32 payloadLen | u32 recordCount | payload | u32 crc32
[index]             u32 "IDX1" | u32 count | count*(u32 seq, u64 blockOffset) | u32 crc32
[footer]            u64 indexOffset | "DLOGEND1"
```

- Records inside a block are delta-encoded against the previous record
  (varint seq delta, zigzag varint timestamp/status deltas); strings and
  payloads are length-prefixed.
- Record types: `event` (seq, ts, device, status, payload),
  `correction` (+ refSeq, reason), `tombstone` (refSeq, reason).
- The tail index maps every record seq to its block offset. If the footer or
  index fails validation on open, the index is rebuilt by a full sequential
  scan of the blocks.

## Semantics

- **Append-only**: events cannot be deleted or modified.
- **Correction** references an existing event seq and must carry a reason;
  it updates the active view entry (status/payload).
- **Tombstone** references an existing event seq with a reason and removes
  it from the active view. Both remain in the audit history forever.
- **Incremental decode**: restore the baseline events, then fold corrections
  and tombstones in seq order -> active view + full audit history.
- **Blocks apply atomically**: a block whose CRC fails contributes nothing;
  decoding stops there with `E_CRC` and all writes are refused, so no
  half-updated state is possible.
- **Certificates**: every correction/tombstone returns a certificate with
  the sha256 of the original record, the sha256 of the correction record and
  the correction's seq (`activeSeq`). `verifyCertificate` re-derives both
  hashes from the log.

## Error codes and CLI exit codes

| code         | meaning                              | exit |
|--------------|--------------------------------------|------|
| `E_USAGE`    | bad/missing arguments or reason      | 2    |
| `E_CRC`      | data block crc mismatch              | 3    |
| `E_REVISION` | referenced event does not exist      | 4    |
| `E_FORMAT`   | malformed file/block/record          | 5    |
| `E_INDEX`    | tail index corrupt (auto-rebuilt)    | 6    |

## CLI

```
node cli.js append  <file> --device D --status N [--payload S] [--ts N]
node cli.js correct <file> --ref SEQ --reason S [--status N] [--payload S] [--ts N]
node cli.js revoke  <file> --ref SEQ --reason S [--ts N]
node cli.js view    <file> [--partial]     # active view (--partial tolerates E_CRC)
node cli.js audit   <file>                 # full history with record hashes
node cli.js get     <file> --seq N         # single record via tail index
node cli.js verify  <file> --cert <cert.json|inline-json>
node cli.js rebuild <file>                 # force full-scan index rebuild
```

## Library

```js
const { EventLog } = require('./src/eventlog');
const log = EventLog.open('device.log');
const seq = log.append({ device: 'pump-1', status: 7, payload: 'on' });
const { certificate } = log.correct(seq, { reason: 'misread', status: 8, payload: 'off' });
log.flush();                    // or log.close()
log.view();                     // active view (throws LogError E_CRC on corrupt block)
log.safeView();                 // { view, error } of the intact prefix
log.audit();                    // full history with per-record sha256
log.verifyCertificate(certificate);
log.rebuildIndex();
```

## Tests

```
node --test
```

Covers: append vs. independent manual fold, delta round-trip, out-of-order
corrections + certificate re-verification, tombstones, corrupt block
(`E_CRC`, atomic block rejection, no half-updated state), corrupt index
full-scan rebuild with identical results after restart, `E_REVISION`, CRC32
vectors, and CLI end-to-end including exit codes.
