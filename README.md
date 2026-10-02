# evlog — offline append-only device event log

Node.js 22, standard library only. Tests use `node:test`.

## Layout

- `src/format.js` — binary format: varint/zigzag codec, delta-encoded records, CRC32 blocks, tail index
- `src/crc32.js` — CRC-32 (IEEE)
- `src/log.js` — `EventLog`: append / correct / revoke, block flush, index rebuild
- `src/decoder.js` — incremental `Decoder`: baseline restore + fold of corrections/tombstones
- `src/certificate.js` — correction certificates (original hash + correction hash + active seq)
- `bin/cli.js` — `evlog` CLI

## File format

```
file   = "EVL1" block* index
block  = "EB" ver u8 count varint payloadLen u32le payload crc32
record = type u8 | seqDelta svarint | tsDelta svarint | fields...
index  = entries crc32 payloadLen u32le "EIDX"   (seq -> block offset)
```

Seq/ts are delta-encoded against the previous record inside a block. Every
block is CRC32-protected; the tail index maps sequence numbers to block
offsets and is rebuilt by a full scan whenever it is missing or corrupt.

## Semantics

- Events are immutable; corrections (`correct`) and revocations (`revoke`,
  tombstone) are appended records that must reference an existing event seq
  and carry a reason, otherwise `E_REVISION`.
- The decoder folds records by seq: latest correction wins, tombstoned events
  leave the active view but stay in the audit history.
- A block failing CRC aborts the decode with `E_CRC`; already decoded blocks
  stay intact and nothing from the bad block is applied.
- `certify` issues `{ targetSeq, originalHash, correctionHash, activeSeq }`;
  `verify` re-derives all hashes from the log.

## CLI

```
node bin/cli.js append  log.evl --device pump-1 --status 0 --payload start
node bin/cli.js correct log.evl --seq 1 --reason "sensor drift" --status 7
node bin/cli.js revoke  log.evl --seq 2 --reason "duplicate"
node bin/cli.js view log.evl        # active view (JSON)
node bin/cli.js history log.evl     # full audit history (JSON)
node bin/cli.js certify log.evl --seq 1
node bin/cli.js verify  log.evl --cert '{"version":1,...}'
node bin/cli.js rebuild-index log.evl
```

Errors print `<CODE>: message` on stderr and exit non-zero (`E_CRC`,
`E_REVISION`, ...).

## Tests

```
node --test
```
