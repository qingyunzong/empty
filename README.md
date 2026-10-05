# interval

Exact arithmetic on rational closed intervals, in pure Go (standard
library only, `math/big`).

## Features

- **Rational closed intervals** (`Interval`): endpoints are `*big.Rat`,
  so all arithmetic is exact. Supports `Add`, `Sub`, `Mul`, `Div`.
- **Undefined on division by zero**: `Div` returns the undefined
  interval whenever the divisor contains 0 (point evaluation: divisor
  equal to 0). Undefined propagates through arithmetic and branches.
- **Branching** (`If` with `Cond` comparisons `<, <=, >, >=, ==, !=`):
  expression trees evaluate exactly at a point (`Eval`) or over
  intervals (`EvalInterval`), where an undecidable condition joins both
  branches with `Hull`.
- **Exact extrema respecting dependencies**: plain interval evaluation
  treats every variable occurrence as independent and overestimates
  (e.g. `x - x` over `[0,1]` gives `[-1,1]`). `Enumerate` evaluates the
  expression on the cartesian product of per-variable rational grids —
  at most 6 variables — so shared-variable dependencies are preserved
  and extrema are exact on the grid.
- **Certificates**: `Enumerate` returns a `Certificate` with min/max,
  witnessing assignments, and defined/undefined counts. `Check`
  re-enumerates and verifies a certificate; `VerifyBounds` checks a
  claimed bound against every grid point.

## Example

```go
e := interval.Sub{interval.Var{0}, interval.Var{0}} // x - x
dom := []interval.Interval{interval.New(interval.Rat(0, 1), interval.Rat(1, 1))}
iv, _ := interval.EvalInterval(e, dom) // [-1, 1] (over-approximate)

cert, _ := interval.Enumerate(e, [][]*big.Rat{
    {interval.Rat(0, 1), interval.Rat(1, 2), interval.Rat(1, 1)},
}) // min = max = 0 (exact)
err := cert.Check(e, grids) // independent verification
```

## Test

```sh
go test ./...
```
