# intfold

Go library that parses, evaluates and constant-folds 32-bit wraparound
integer expressions with short-circuit semantics.

## Semantics

- All arithmetic is `int32` two's-complement wraparound (including
  `MinInt32 / -1` and negation of `MinInt32`); literals wrap at parse time.
- `&&` / `||` short-circuit; `?:` evaluates only the taken branch.
  Logical and comparison operators yield 0/1.
- Division/modulo by zero is a **run-time trap** carrying the source span —
  never a compile-time error.

## Folding rules

- `Fold` never fails and never mutates its input.
- A must-execute constant `x / 0` or `x % 0` folds to a `TrapNode` that
  faults at run time with the original source span.
- Branches discarded by short-circuiting (`0 && ...`, `1 || ...`,
  constant-condition `?:`) are dropped **unfolded**, so a division by zero
  inside them stays silent.
- `c && r` / `c || r` reductions normalize the result to 0/1 (`r != 0`).
- Every rewrite records a provenance note (`Expr.Prov`); `Dump` renders the
  AST with source spans and notes.

## Usage

```go
e, _ := intfold.Parse("x && 1 / 0")
f := intfold.Fold(e)
fmt.Print(intfold.Dump(f))          // AST + spans + provenance
v, trap := intfold.Eval(f, map[string]int32{"x": 1})
```

Run the demo: `go run ./cmd/folddemo`

## Tests

`go test ./...` runs unit tests plus a randomized differential test that
generates expressions (seeded), evaluates the original and folded ASTs on
random inputs, and requires identical values and identical trap positions.
