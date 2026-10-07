# chunk-ledger

Offline chunked settlement ledger (Node.js 22, standard library only, `node:test`).

Stores receive/pay settlements, transaction cancels and credit freezes as a
sequence of CRC32-protected blocks, with a standalone index recording every
block's offset.

## Files

- `<file>` — data blocks. Each block: magic, block length, seq, start/end
  offsets, previous-block CRC32, tx count, tx deltas, trailing CRC32.
- `<file>.idx` — index: magic, count, then per-block `{seq, offset, length, crc}`.
- `<file>.state.json` — derived state snapshot (balance/frozen/tx statuses +
  applied block count) so normal operations never scan the data file.

## CLI

```
node cli.js append --txid T --kind credit|debit --amount N [--file F]
node cli.js cancel --txid T [--file F]        # idempotent: repeats rejected, state unchanged
node cli.js freeze --txid T [--file F]        # holds funds; balance untouched
node cli.js settle --amount N [--txid T] [--file F]   # checks available = balance - frozen
node cli.js verify [--rebuild] [--file F]
node cli.js dump [--file F]
```

All output is JSON. Errors are `{"ok":false,"code","block","message"}` on stderr.

Exit codes: `0` ok, `1` business rejection (e.g. insufficient funds, cancel
conflict), `2` data corruption (first bad block reported), `3` usage/internal.

## Crash model & recovery

Write order per block: data block + `fsync` -> index + `fsync` -> state snapshot.
The defined fault point is a crash after the block is fsynced but before the
index is updated (orphan block). Normal-path decoding is incremental: it
resumes at the block recorded in the state snapshot and seeks via the index —
never a full data-file scan.

`verify --rebuild` sequentially scans blocks, validates length/CRC/prev-CRC
chain, rebuilds the index (identical to the original) and truncates any
corrupt tail. The first bad block is reported with exit code 2; the bad block
and everything after it are excluded from the index and state.

## Tests

```
node --test > result.txt 2>&1; echo $? >> result.txt
```
