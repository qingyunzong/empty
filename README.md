# planstore

Offline production-planning store and CLI for a single industrial machine.
Node.js 22, standard library only, tests via `node:test`.

## Data model

A work order is `{ id, quantity, dueDate, capability }` where `capability`
is the machine-hours required per unit; an order's load is
`quantity * capability`. The store keeps a configured daily machine capacity.

## On-disk layout

A store is a directory with three files:

- `store.dat` — concatenated chunks. Each chunk is
  `[u32 LE payload length][u32 LE crc32(payload)][payload]`, where the payload
  is a JSON batch `{ "type": "orders", "orders": [...] }`.
- `manifest.json` — the manifest and offset index:
  `{ version, capacity, chunks: [{offset, length, crc32}], checkpoints: {name: chunkCount} }`.
- `manifest.tmp` — staging file for atomic manifest replacement.

## Append and crash semantics

Append writes the new chunk bytes past the indexed region (an invisible temp
tail), fsyncs, writes the updated manifest to `manifest.tmp`, fsyncs, then
renames it over `manifest.json`:

- Crash **before** the rename: the tail is not referenced by any manifest and
  is invisible; the next append truncates it before writing.
- Crash **after** the rename: the chunk is fully visible.

Decoding is incremental: chunks are read and CRC-checked one at a time while
the cumulative machine load is maintained. A CRC failure at chunk `i` reports
`E_CRC` with the chunk number; the decoded prefix `[0, i)` is returned and
later chunks never touch state. Named checkpoints record a chunk count in the
manifest; rollback truncates the index first, so rolled-back chunks are never
decoded, then truncates the data file and swaps the manifest in atomically.

## Scheduling

`schedule` considers permutations feasible when every order fits within one
day of capacity (orders are atomic; days are packed greedily in sequence) and
picks the lexicographically smallest sequence of `(dueDate, id)` — i.e. due
date first, then smallest order id. If any order exceeds daily capacity it
fails with `E_CAPACITY`.

## CLI

```
node src/cli.js init <dir> --capacity <n>
node src/cli.js add <dir> [--orders '<json-array>']   # or JSON on stdin
node src/cli.js schedule <dir>
node src/cli.js checkpoint <dir> --name <name>
node src/cli.js rollback <dir> --name <name>
node src/cli.js verify <dir>
node src/cli.js replay <dir>
```

All output is JSON on stdout. Errors are JSON on stderr with a stable `code`
and a non-zero exit status: `E_CRC` (2), `E_INDEX` (3), `E_CAPACITY` (4),
`E_INPUT` (5). `E_CRC` errors include `chunk`, `decodedChunks`,
`prefixOrders` and `prefixCumulativeLoad`.

## Tests

```
node --test
```
