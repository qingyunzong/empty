# pieceaffine

Piecewise affine maps on bounded half-open integer domains, with exact
preimage (inverse image) queries.

- `Interval` — canonical half-open integer interval `[Lo, Hi)`;
  `Canonical` sorts, drops empties and merges overlapping/adjacent intervals.
- `Map` — pieces `f(x) = floor((A*x + B) / C)` with `C > 0`; `A` may be
  negative (orientation flip) or zero (constant). `Preimage`/`PreimageSet`
  solve `f(x) ∈ y` exactly over integer arithmetic and return canonical
  intervals.
- `Chain` — ordered composition of maps with versioned batch edits
  (`ApplyBatch` is atomic and bumps `Version`). `Chain.Preimage` inverts
  layer by layer, traversing every intermediate rounding instead of
  merging coefficients, and returns a per-layer `Proof`.
- `Session` — pausable/resumable layered preimage; emitted result
  intervals are charged against a budget, and the session is plain
  JSON-serializable data so a paused run can be stored and resumed.

Tests verify short domains value-by-value against brute-force references
(single maps and direct composite evaluation), including endpoints and
orientation flips:

```sh
go test ./...
```
