# resample

Streaming resampler onto a fixed-interval grid, Go standard library only
(`math/big` for exact rational arithmetic).

## Contract

- Input points carry rational time and value (`*big.Rat`); times must be
  strictly increasing across the whole stream, including across breaks.
- Output grid is `origin, origin+step, origin+2*step, ...` with an explicit
  origin and a positive rational step; all arithmetic is exact.
- Consecutive points form segments; grid times inside a segment are
  piecewise-linearly interpolated. A grid time equal to a known point
  yields that point's exact value.
- `Break` ends the current run: the gap to the next run is a missing
  segment and is never interpolated across.
- No extrapolation: nothing before the first point or after the last point
  of a run. `End` signals end of input; the tail without a right endpoint
  stays empty even after `End`.

## API

```go
r := resample.New(origin, step)   // *big.Rat origin, positive step
out := r.Add(t, v)                // []Sample determined by this point
out = r.AddAll([]Point{...})      // batch convenience, chunk-invariant
r.Break()                         // mark a missing segment
r.End()                           // end signal; no tail extrapolation
```

## Tests

`go test ./...` — behavior tests (explicit origin, missing segments,
no head/tail extrapolation, exact rational endpoints, contract panics)
plus a randomized test feeding 500 random inputs whole and in random
chunks, both checked exactly against an independent rational model.

Last run (Go 1.27.1, linux/amd64): all 10 tests PASS, `ok resample 0.094s`.
