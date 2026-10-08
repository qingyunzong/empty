# rescheck

A checker for a simplified imperative IR with branches and loops.
Protocol: a resource must be consumed **exactly once** after creation;
`move` invalidates the source variable; exceptional exits (`Throw`)
must also leave no live resource.

## Model

- IR (`ir.go`): `New`, `Move`, `Consume`, `Seq`, `If`, `While`, `Throw`.
  Conditions are non-deterministic: both branches / all iteration
  counts are explored.
- Abstract domain (`analyze.go`): each variable is one of
  `empty | alive | moved | consumed` — finite, so sets of states are
  finite and analysis always terminates.
- The interpreter propagates **sets of states** (each carrying a
  witness path). `If` merges both arms via set union; `While` iterates
  `head = head ∪ exec(body, head)` to a fixpoint; `Throw` and normal
  exit check for leaked (still `alive`) resources.
- Violations (`invalid-consume`, `invalid-move`, `leak-overwrite`,
  `leak-at-exit`, `leak-at-throw`) are reported with a readable
  witness path, deduplicated across fixpoint iterations.

## Run

    go test ./...   # path-expansion tests for merge points & loop fixpoints
    go run ./cmd/demo
