# settlement-audit-store

Chunked settlement audit log library and CLI. Node.js 22, standard library only (`node:test` for tests).

## Chunk format

Each chunk is a self-contained record appended to the data file:

| Offset | Size | Field |
|--------|------|-------|
| 0 | 4 | magic `SCHK` |
| 4 | 1 | version (1) |
| 5 | 1 | flags (0) |
| 6 | 2 | header length (64) |
| 8 | 4 | event count |
| 12 | 4 | payload length |
| 16 | 32 | prev chunk hash (SHA-256 of previous chunk bytes; zeros for first) |
| 48 | 8 | end offset (absolute file offset of chunk end) |
| 56 | 4 | CRC32 of header[0..56) + payload |
| 60 | 4 | reserved (0) |

Payload: `len(u32) + JSON` per event. Events: `deposit` (缴款), `refund` (退款), `fee` (手续费结算), `cancel` (撤销, links to the original event via `ref`).

A global index (`<file>.index.json`) maps account and tx to chunk offsets, so `find` decodes only the relevant chunks. Quarantine state lives in `<file>.quarantine.json`.

## CLI

```
node cli.js append <file> --event '<json>' [--event ...]
node cli.js audit <file>
node cli.js find <file> --tx <tx> | --account <acc>
node cli.js cancel <file> --tx <tx>
node cli.js quarantine <file>
node cli.js rebuild <file>
```

All output is JSON. Exit codes: `0` ok, `1` business error (negative balance refund, unknown/duplicate tx, bad args), `2` corruption (CRC/chain failure, broken chain).

- A chunk with a bad CRC is quarantined; state only includes previously confirmed chunks. Later chunks are `pending` (broken chain) and never auto-applied.
- Zero padding at the file tail is treated as an incomplete tail: `rebuild` truncates it and reports `truncated: 1` (not corruption). Repeated rebuilds are idempotent.

## Tests

```
node --test
```
