# planline

Offline production planning store and CLI for a single industrial PC.
Node.js 22, standard library only, tested with `node:test`.

## Store format

A store is a directory with three files:

- `data.bin` — append-only sequence of chunks. Each chunk is
  `u32le magic | u32le payload length | JSON payload | u32le crc32(payload)`.
- `manifest.json` — the committed offset index: per-chunk
  `{offset, length, crc32}` plus named checkpoints with machine-load snapshots.
- `manifest.tmp` — transient commit file.

Append protocol: chunk bytes are appended to `data.bin` and fsynced first,
then the updated manifest is written to `manifest.tmp`, fsynced and renamed
onto `manifest.json`. The rename is the commit point:

- crash **before** the rename → the unindexed tail of `data.bin` is invisible
  and is truncated on the next open, so appending stays safe;
- crash **after** the rename → the chunk is fully visible.

Decoding is incremental: chunks are read and CRC-checked one at a time while
the cumulative machine load (`{machine: totalQuantity}`) is maintained. A CRC
failure raises `E_CRC` carrying the failing chunk number and the consistent
decoded prefix; nothing past the bad chunk is applied. `rollback(name)`
restores a checkpoint using only the manifest index and the checkpoint's load
snapshot — rolled-back chunks are never decoded.

## Scheduling

Orders run one at a time on a single line; an order occupies its machine for
`ceil(quantity / dailyCapacity[machine])` whole days. A permutation is
feasible when every order finishes on or before its due day. Among feasible
permutations the one sorted by `(due, id)` is selected (earliest-due-date
optimality: it is feasible whenever any permutation is, and it is the
lexicographically smallest `(due, id)` sequence). Infeasible input raises
`E_CAPACITY`.

## CLI

```
plan init <dir>
plan add <dir> --order '{"id":"WO-1","quantity":10,"due":5,"machine":"M1"}'
plan list <dir>
plan schedule <dir> --capacity '{"M1":6,"M2":5}'
plan checkpoint <dir> <name>
plan rollback <dir> <name>
plan verify <dir>
```

All output is JSON on stdout. `--order` / `--capacity` accept inline JSON,
`@file`, or `@-` for stdin. `due` is a day index or an ISO `YYYY-MM-DD` date.
Errors print `{"ok":false,"error":{...}}` to stderr and exit non-zero:

| code        | exit | meaning                                  |
|-------------|------|------------------------------------------|
| `E_USAGE`   | 1    | bad arguments or malformed order JSON    |
| `E_CRC`     | 2    | chunk crc32 mismatch (prefix decodable)  |
| `E_INDEX`   | 3    | manifest/offset index inconsistent       |
| `E_CAPACITY`| 4    | no feasible schedule under capacity      |
| `E_STATE`   | 5    | missing store / unknown checkpoint       |
| `E_IO`      | 6    | unexpected I/O failure                   |

## Tests

```
node --test
```

Coverage includes: a 5-order example checked against brute-force enumeration
of all permutations (plus 200 seeded randomized cases), byte-identical
manifest replay after rollback, single-byte chunk corruption reporting the
chunk number with a clean decodable prefix, and a simulated power loss before
the manifest rename followed by safe append.
