# dreach

`dreach` is a Python 3.11 standard-library CLI for a directed, unweighted graph with savepoint-based rollback. Repeated insertion or deletion of the same edge is idempotent.

## Usage

Create an operation file, for example `OPS.json`:

```json
[
  {"op": "init", "n": 4},
  {"op": "insert", "u": 0, "v": 1},
  {"op": "insert", "u": 1, "v": 3},
  {"op": "savepoint"},
  {"op": "reachable", "u": 0, "v": 3},
  {"op": "witness", "u": 0, "v": 3},
  {"op": "delete", "u": 0, "v": 1},
  {"op": "rollback", "savepoint": 1},
  {"op": "witness", "u": 0, "v": 3}
]
```

Run it:

```bash
python -m dreach run OPS.json
```

The result is JSON with one entry per operation. Mutation results are `null`; `savepoint` returns a monotonic integer; `reachable` returns a boolean; `witness` returns the lexicographically smallest shortest node sequence, or `null` when unreachable.

Operations:

- `init`: replace current state with an empty graph containing `n` nodes.
- `insert`: add directed edge `u -> v`.
- `delete`: remove directed edge `u -> v` if present.
- `savepoint`: save the current graph and return a new monotonic ID.
- `rollback`: restore the chosen savepoint; additions, deletions, and later savepoints after it are invalidated, while older state and snapshots are retained.
- `reachable`: test whether `v` is reachable from `u`; a node is reachable from itself.
- `witness`: return a shortest path from `u` to `v`, choosing the lexicographically smallest sequence among shortest paths.

Exit codes:

- `0`: all operations completed.
- `1`: rollback referred to a nonexistent savepoint; the in-memory engine state was checked before mutation and remains unchanged.
- `2`: malformed JSON, an invalid operation, an unreadable file, or invalid arguments.

## Tests

```bash
python -m unittest -v 2>&1 | tee result.txt
```
