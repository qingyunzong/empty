# kv-merge

Local transactional KV store with a causal WAL, log-segment export/import
between offline replicas, and a serializability checker for merged histories.
Node.js 22, standard library only, tests with `node:test`.

## Model

Multiple labs each maintain an offline replica of the evidence database.
Each replica commits transactions locally (read/write keys), periodically
exports a log segment, and imports segments from other replicas. The merger
decides whether the merged global history is equivalent to some serial
execution.

- **Transaction**: `{id, site, clock, parents, reads, writes}`. `reads`
  records the value observed for each read key (`null` = key absent).
- **Causal timestamp**: every commit carries a vector clock (`clock`) and
  the commit-graph frontier (`parents`). The local clock is the element-wise
  max of all known transaction clocks, ticked on each commit; importing a
  segment merges remote clocks in.
- **WAL**: one checksummed JSON line per commit in `<dir>/wal.log`
  (sha256 over the canonical JSON of the transaction). On open, the WAL is
  replayed; corrupt lines are skipped and counted (crash recovery).
- **Merged state**: a deterministic function of the known transaction set —
  replay all transactions in *canonical order* (causal topological order by
  vector clock, transaction-id tie-break). Replicas that imported the same
  segments converge to the same state.
- **Snapshot read**: `read(key, {at: clock})` sees exactly the transactions
  causally `<= at`.

## Serializability checking

`checkSerializable(txns, finalState)` builds a transaction dependency graph
with the three classic conflict edges:

- **WR (read-from)**: `Tw -> T` when `T` read the value `Tw` wrote.
- **WW (write-order)**: between writers of the same key, resolved by the
  merged final state (the writer of the final value must be last).
- **RW (anti-dependency)**: `T` read key `k` from `Tw`, and `Tw'` also
  writes `k`: either `Tw' -> Tw` or `T -> Tw'`.

Unambiguous WR/WW constraints are hard edges; the remaining disjunctions are
resolved by an exact DPLL-style search with unit propagation, so the verdict
matches brute-force enumeration of all serial permutations (the test oracle
`bruteForceSerializable`).

- **Cycle found** → `NON_SERIALIZABLE` plus a concrete conflict-cycle
  witness (e.g. `A:2 -> B:1 -> A:2`).
- **Acyclic** → a topological order is emitted as the equivalent serial
  history; replaying it reproduces the merged state by construction (and is
  verified: `consistent: true`).

## CLI

```
node cli.js --dir D [--site S] commit --read k1 --write k2=v2 [--write k3=v3]
node cli.js --dir D read <key> [--at '{"A":2}']
node cli.js --dir D export [--out seg.jsonl] [--since '{"A":1}']
node cli.js --dir D import <seg.jsonl>
node cli.js --dir D check
node cli.js --dir D replay
```

`--site` defaults to the data-dir basename. Exit codes:

| code | meaning |
|------|---------|
| 0 | ok / `SERIALIZABLE` (and replay consistent) |
| 3 | `NON_SERIALIZABLE` |
| 4 | import saw `CORRUPT` entries (valid entries still imported, bad ones skipped) |
| 2 | usage / IO error |
| 5 | replay mismatch with merged state |

Error conventions: a corrupt log segment (bad JSON or checksum mismatch)
reports `CORRUPT` and skips only the bad entries; re-importing a segment is
idempotent (duplicates are counted and skipped).

### Example: conflicting merge

```
$ node cli.js --dir demo/A check
NON_SERIALIZABLE
conflict cycle: A:2 -> B:1 -> A:2
reason: antidep
(exit code 3)
```

## Tests

```
node --test
```

Coverage:

- `test/store.test.js` — commit/read, snapshot reads at a vector clock,
  crash recovery from the WAL, corrupt/tampered WAL lines skipped.
- `test/merge.test.js` — acceptance scenario 1 (two non-conflicting replicas
  merge, `check` passes, states converge) and scenario 2 (concurrent
  read/write of the same key → `NON_SERIALIZABLE`, cycle transactions exist
  in the store); import idempotency; corrupt segment handling; `export
  --since`.
- `test/serialize.test.js` — acceptance scenario 3: 400 random mixed
  serializable/non-serializable histories cross-checked against the
  brute-force permutation oracle, plus hand-built chain/cycle cases.
- `test/cli.test.js` — end-to-end CLI flows for two replicas, conflict
  detection, and corrupt-segment exit code.

### Real results (2026-10-03, Node v22.22.1)

```
$ node --test
# tests 4
# pass 4
# fail 0
# duration_ms ~40000-70000 (sandboxed machine)
```

The random-history test logged:

```
random histories: 296 serializable, 104 non-serializable (of 400)
```

i.e. the generator produces a genuine mix, and the graph checker agreed with
the brute-force oracle on all 400 instances (and every emitted serial order
replayed to the merged state).

## Layout

```
cli.js            CLI entry (commit/read/export/import/check/replay)
src/clock.js      vector-clock compare/merge
src/segment.js    WAL/segment encoding, canonical JSON, sha256 checksums
src/store.js      Store: commit, snapshot read, WAL recovery, export/import
src/serialize.js  dependency-graph checker, cycle witness, topo order,
                  canonical merge order, replay, brute-force oracle
test/             node:test suites
```
