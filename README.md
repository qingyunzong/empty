# bdd

A reduced ordered binary decision diagram (ROBDD) library in pure Go
(standard library only).

## Features

- At most 16 variables (`MaxVars`), fixed initial order `x0 < x1 < ...`.
- Boolean operations: `Not`, `And`, `Or`, `Xor`, `Imply`, `Equiv`, `Ite`.
- Quantification: `Exists`, `ForAll`.
- Normalized, shared nodes: a unique table plus the reduction rule
  (`low == high` collapses) keep every triple `(var, low, high)` shared.
- Dynamic reordering: `Reorder`, `SwapAdjacent`, and `Rebuild` to
  re-canonicalize a handle under the current order. Old handles keep
  denoting the same Boolean function across reordering.
- Reference counting: `Ref`/`Release`; releasing a handle never deletes
  nodes still reachable from other live handles or the unique table.
- Evaluation: `Eval`, `TruthTable` (full 2^n table), `Support`.

## Invariants

- Every public constructor/operation returns an owned handle; call
  `Release` when done. `NodeCount` returns to 0 once everything is
  released.
- Cofactoring and quantification use semantic substitution, so results
  stay correct even for nodes built under a previous variable order.

## Testing

```
go test ./...
```

Every operation is checked against full truth-table models (up to 2^16
entries), including a randomized 16-variable test that mixes operations,
quantification, reordering, rebuilds, and releases.
