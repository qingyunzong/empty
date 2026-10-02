# audit-tail-decoder

Financial audit log with tail-incremental chunked decoding. Node.js 22, standard
library only, tests via `node:test`.

## File layout

A ledger is a data file plus a sidecar manifest (`<file>.manifest`):

- **Anchor snapshot block** — full state (accounts, payments, seq) at a point in time.
- **Delta block** — a batch of events (`pay` / `cancel` / `limit`) with a seq range.
- **Tail manifest** — JSON index of the most recent N blocks plus a pointer to the
  latest anchor. Written atomically: staged to `<file>.manifest.tmp`, fsynced, then
  renamed. On load, a stale tmp is discarded when the old manifest exists; if the
  main manifest is missing but the tmp exists, the tmp is adopted.

Block binary format: `magic(4) kind(1) seqStart(8) seqEnd(8) prevHash(32)
payloadLen(4) payload(JSON) crc32(4)`. Each block's hash is SHA-256 over the whole
block; `prevHash` chains blocks forward. CRC32 covers header + payload.

## State machine

- `pay` — account must exist, amount > 0, within available credit (`limit - used`).
- `cancel` — must reference a valid, not-yet-cancelled payment (`UNKNOWN_PAYMENT`,
  `ALREADY_CANCELLED`).
- `limit` — creates/adjusts an account limit; rejected when it would make available
  credit negative (`NEGATIVE_AVAILABLE`).

## CLI

```
node src/cli.js init     <file> [--window N]
node src/cli.js append   <file> <eventJson>...
node src/cli.js snapshot <file>
node src/cli.js tail     <file> --n K [--state 1]
node src/cli.js verify   <file> [--to SEQ]
node src/cli.js anchor   <file>
node src/cli.js cancel   <file> <paymentId>
```

`tail --n K` serves from the manifest index when it covers the requested range;
otherwise it walks the forward block chain from the latest anchor (never reading
earlier snapshots). Events at or before the latest anchor are folded into its
snapshot. Errors are JSON on stderr with `code` and `range`, exit code 1.

## Tests

```
node --test
```
