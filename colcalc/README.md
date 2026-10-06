# colcalc

Column computation over JSON tables (arrays of objects) in Go.

## Semantics

- **Three independent states** alongside concrete values (number, string, bool):
  `missing` (key absent in the row), `null` (JSON null), `error`
  (type mismatch, division by zero, ...). They never collapse into each
  other. State predicates `IsMissing` / `IsNull` / `IsError` expose them
  to expressions.
- **Propagation**: through arithmetic, comparison and logic operators the
  precedence is `error > missing > null`.
- **Lazy conditionals**: `If` evaluates the condition, then only the
  selected branch. Errors, nulls and missing keys in the unselected
  branch cannot pollute the result. A null/missing/error condition
  propagates that state.
- **Per-row typing**: every row is interpreted independently from its own
  JSON data. `Table.InferKinds` reports the result kind row by row —
  nothing is inferred from the first row.

## API sketch

```go
tab, _ := colcalc.ParseTable([]byte(`[{"price":10,"qty":2},{"price":5}]`))
total := colcalc.Arith{Op: colcalc.Mul, L: colcalc.Col{"price"}, R: colcalc.Col{"qty"}}
vals := tab.Compute(total)      // [number(20), missing]
kinds := tab.InferKinds(total)  // [number, missing]
rows := tab.ComputeColumn("total", total)
```

## Tests

`go test ./...` runs deterministic unit tests plus randomized
cross-checks of the evaluator against an independent reference
interpreter (`prop_test.go`) over mixed inputs (numbers, strings,
bools, nulls, absent keys), including structural laziness checks for
`If`.

## Note on sandboxes

If `$HOME/.cache/go-build` is read-only (restricted sandboxes), point
the build cache elsewhere: `GOCACHE=$(mktemp -d) go test ./...`.
