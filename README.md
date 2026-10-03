# batch-lineage

Manufacturing batch lineage ledger. Node.js 22, standard library only, tests
with `node:test`. No dependencies.

Batches are split or merged from parent batches into child batches. The ledger
tracks genealogy (bidirectional parent/child secondary indexes), weight
conservation, and QC status. A top-level transaction may contain nested
savepoints; commits are atomic via a write-ahead log (WAL); every commit
produces SHA256 lineage certificates.

## Layout

- `src/db.js` — core engine: state, validation, savepoints, WAL, recovery
- `src/certificate.js` — SHA256 lineage certificates over canonical JSON
- `src/canonical.js` — deterministic JSON serialization
- `src/errors.js` — `BusinessError` / `CorruptionError`
- `src/cli.js` — offline single-machine CLI (JSON in, JSON out)
- `test/` — acceptance and unit tests

## Semantics

- `create` registers a root batch with an initial weight.
- `split` takes 1..n parents and 1..n new children (split and merge).
  Weight conservation: total child weight must not exceed the sum of the
  parents' *effective* weights (`weight - consumed`); consumption is allocated
  greedily across the parents in order. Cyclic ancestry is rejected.
- `status` sets QC status: `pending|passed|failed|quarantined|released`.
- Savepoints (`savepoint` / `release` / `rollback`) nest inside one top-level
  transaction. `release` drops the boundary (and savepoints nested after it)
  but keeps all modifications; `rollback` undoes every split, index and status
  change made after the savepoint, keeping the named savepoint reusable.
- Commit appends the transaction's op records to `wal.log`, fsyncs, then
  appends and fsyncs a commit marker. Crash before the marker: tentative
  changes are invisible after recovery. Crash after the marker: committed ops
  are redone and both index directions rebuilt. A torn tail write is
  truncated; a corrupted record anywhere else is a corruption error.
- Each WAL line is `<sha256> <json>`; the checksum covers the JSON payload.
- A batch's certificate is
  `sha256(canonical({id, weight, status, parents: [sorted parent certs]}))`,
  committing to its entire ancestry closure.

## CLI

```
node src/cli.js <dbdir> <command> [json-args | -]
```

- `exec '<json-array>'` — run a transaction script, e.g.
  `[{"cmd":"begin"},{"cmd":"create","args":{"id":"A","weight":100}},{"cmd":"commit"}]`
- `create` / `split` / `status` — single mutation, auto-committed
- `get` `children` `parents` `ancestors` `descendants` `certificate` `state` — queries
- `recover` — open the database and run WAL recovery
- `-` as the argument reads JSON from stdin

Exit codes: `0` ok, `1` business error, `2` corruption/internal error.
Output is always a single JSON line on stdout.

## Tests

```
node --test
```

Covers: savepoint rollback/release semantics, weight conservation, cycle
rejection, crash before/after the commit marker, torn-tail and mid-file
corruption, CLI exit codes, and an exhaustive enumeration of operation
sequences over up to 4 savepoints checked against an independent recursive
DFS reference implementation (weights, ancestor sets, certificates).
