# auditlog

Append-only audit log CLI with framed records, CRC protection, torn-write
recovery, and a rebuildable index. Go standard library only.

## Frame layout (big-endian)

```
+--------+--------+---------+----------+=========+--------+
| uint32 | uint32 | uint64  | uint32   | payload | uint32 |
| magic  | length | seq     | hdrCRC32 |         | CRC-32 |
+--------+--------+---------+----------+=========+--------+
```

- `hdrCRC32` covers `magic+length+seq`; the trailing CRC-32 (IEEE) covers
  the 20-byte header plus payload.
- The header checksum lets recovery distinguish a torn write (incomplete
  bytes at the tail) from in-place corruption of the length field.

## Commands

```
auditlog append  -log FILE [-seq N] payload...   # default seq = last+1
auditlog verify  -log FILE                       # frames + tail check
auditlog recover -log FILE                       # truncate incomplete tail only
auditlog reindex -log FILE [-index FILE]         # rebuild seq->offset index
auditlog list    -log FILE
```

## Guarantees

- **Recovery** truncates only an incomplete tail frame. A complete frame
  with a bad checksum (mid-file or tail) is reported and the original file
  is left byte-for-byte unmodified.
- **Append** refuses corrupt logs and logs with an incomplete tail, and
  rejects duplicate sequence numbers.
- **Index** may lag the log; `reindex` re-scans the log. Duplicate sequence
  numbers with different content are an error; identical duplicates
  (idempotent re-delivery) are tolerated.

## Acceptance tests (`auditlog_test.go`)

- `TestRecoverByteByByteTruncation` — truncates the log at every byte
  offset; recovery must yield exactly the valid frame prefix.
- `TestRecoverSingleByteCorruption` — flips every single byte; recovery
  must error and must not modify the file.
- `TestReindexDetectsDuplicateSeq`, `TestIndexLagAndRebuild`,
  `TestAppendAutoSeqAndDuplicateReject`, `TestCLIEndToEnd`, and more.

See `TEST_RESULTS.md` for the recorded `go test ./...` result.
