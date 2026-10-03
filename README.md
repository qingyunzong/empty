# devlog-wal

Offline, single-machine event store for device telemetry (start/stop, alarm,
counter events) with an append-only WAL, CRC32-checked frames, crash recovery
and a secondary `deviceId+seq` index. Node.js 22, standard library only,
tests via `node:test`.

## Layout

- `src/crc32.js` — CRC-32 (IEEE), table-driven.
- `src/wal.js` — frame encode/scan. Frame layout (little-endian):
  `u32 length | u32 walSeq | u8 type | payload | u32 crc32(header+payload)`.
  Type `0x01` = data, `0x02` = commit marker (length 0).
- `src/store.js` — `EventStore`: append protocol, recovery, indexes.
- `src/cli.js` — offline CLI (JSON in / JSON out).
- `test/` — `node:test` suites.

## Durability protocol

`append` writes one logical record as two frames:

1. write data frame            → fault point `after_data`
2. `fsync` data frame          → fault point `after_sync`
3. write commit frame, `fsync` → fault point `after_commit`

Recovery scans the WAL, keeps the longest valid prefix (a frame with a bad
length/type/CRC or a torn tail truncates the file at that offset), and
considers a data frame visible **iff** a valid commit frame with the same
`walSeq` exists in that prefix. Therefore:

- crash at `after_data` / `after_sync` → event is **not** visible after recovery;
- crash at `after_commit` → event **is** visible after recovery.

Indexes (`eventId` primary, `deviceId → seq` secondary) are in-memory only
and rebuilt from committed frames on every open/recovery.

## CLI

```
node src/cli.js append  --wal <path> [--input '<json>'|--input @file]   # or JSON on stdin
node src/cli.js get     --wal <path> --input '{"eventId":"e1"}'
node src/cli.js query   --wal <path> --input '{"deviceId":"d1","seq":2}'  # seq optional
node src/cli.js recover --wal <path>
node src/cli.js crash   --wal <path> --at after_data|after_sync|after_commit [--input ...]
```

Events are JSON objects with required fields `eventId` (unique string),
`deviceId` (string), `seq` (non-negative integer); `type` (e.g. `start`,
`stop`, `alarm`, `count`) and any extra fields are preserved.

Output is single-line JSON on stdout, e.g. `{"ok":true,"walSeq":0,"eventId":"e1"}`
or `{"ok":false,"error":"E_DUP","message":"..."}`.

## Exit codes

| code | meaning                          |
|------|----------------------------------|
| 0    | success                          |
| 1    | E_INTERNAL (unexpected)          |
| 2    | E_DUP (duplicate eventId)        |
| 3    | E_NOTFOUND                       |
| 4    | E_USAGE (bad CLI/input JSON)     |
| 5    | E_VALIDATION (invalid event/query)|
| 6    | E_IO                             |
| 7    | E_CORRUPT                        |
| 70   | simulated crash (`crash` command)|

## Tests

```
node --test
```
