# graphlib

Versioned bipartite graph library in pure Go (standard library only).

## Packages

- `graph` — bipartite graph with stable string vertex IDs.
  - `AddEdge` / `RemoveEdge` mutate edges; every state-changing call
    advances `Version()` and pushes an undo record. `Undo()` reverts the
    most recent change.
  - Duplicate edges collapse to one (re-adding is a no-op); isolated
    vertices are registered via `AddVertex` and survive edge removal.
  - `Analyze()` returns a maximum matching (Hopcroft–Karp) and a minimum
    vertex cover of the same size (Konig's theorem) for the current
    version.
- `verify` — independent checker sharing no algorithm code with `graph`.
  - `CheckMatching`, `CheckCover`, `CheckEqualSizes` validate results.
  - `MinVertexCover` / `MaxMatching` are brute-force references used to
    cross-check small graphs (all 512 graphs on 3x3 vertices are
    enumerated exhaustively in tests, plus randomized edit/undo runs).

## Test

```sh
go test ./...
```

Latest recorded results: see [TEST_RESULTS.md](TEST_RESULTS.md).
