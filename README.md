# boolcov

Instrumented evaluator for boolean ASTs that counts the nodes evaluation
actually reaches.

## Counting contract

- A node is counted the moment its evaluation **begins** — before any
  cancellation check, child evaluation, or variable read.
- `&&` / `||` **short-circuit**: an unreached right operand is never
  evaluated, its variable never read, and its node never counted. No reads
  are performed just for recording.
- **Exceptions count started nodes**: panics and read errors propagate to
  the caller with every node entered so far already counted.
- **Cancellation loses nothing**: counters are incremented with atomics at
  node entry, so racing `context` cancellation cannot drop a started node.

## Coverage tables

- `Freeze(root)` creates a table bound to the source version (whole-tree
  structure hash, IDs excluded). The counted ID set never changes.
- `Table.Migrate(newRoot)` freezes a new table for a rewritten AST: counts
  carry over by stable ID only when the node's own structure is unchanged;
  structurally changed or new nodes start at zero. The old table stays
  frozen and untouched.
- `Executor` is safe for concurrent use; `Executor.Shard()` +
  `Table.Merge()` supports per-goroutine aggregation.

## Testing

```sh
go test ./...
```

Tests cover short-circuit read/count exclusion, panic/error paths, random
ASTs checked against an independent reference evaluator with side-effect
read accounting, version freeze/migration, and barrier-synchronized
concurrency, cancellation, and version-replacement races (`-race` clean).
