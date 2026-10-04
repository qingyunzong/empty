# Recorded test results

Environment: g++ 15.2.0 (Ubuntu), CMake 4.2.3, `-DCMAKE_BUILD_TYPE=Release`.
Recorded: 2026-10-04T21:30:52Z (UTC). Command: `ctest` in `build/`.

## CTest summary

```
100% tests passed, 0 tests failed out of 5
Total Test time (real) =   6.83 sec
```

## Per-test output (actual)

| Test | Checks | Failures | What it covers |
|------|--------|----------|----------------|
| test_rational | 19 | 0 | normalization, arithmetic, comparison, >int64 intermediates |
| test_intersect | 24 | 0 | crossings (incl. rational point (3/2,1/2)), endpoint/T touches, all collinear overlap shapes, degenerate edges |
| test_incremental | 255 | 0 | 60 randomized batch updates (200 initial edges, coords in [-1000,1000]); after every batch: incremental result == full pairwise recompute == fresh-library geometry, certificates valid; targeted dedup scenario keeps source edges |
| test_enumerate | 79971 | 0 | exhaustive small-coordinate acceptance (details below) |
| test_certificate | 7 | 0 | valid result accepted; tampered point / edge set / overlap endpoint / degenerate overlap / unknown edge / single-edge record all rejected |

## Enumeration acceptance (actual counts)

- 5x5 grid `{-2..2}^2`: 300 segments, all **44895 pairs** cross-checked
  against an independent naive implementation (Cramer + witness endpoints):
  **17082 point** and **432 overlap** pair results, 0 mismatches.
- Global library over all 300 edges: certificates valid; every reported
  point/overlap carries exactly the edges passing through it.
- 3x3 grid `{-1..1}^2`: all **7140 triples**; per triple: one-shot ==
  stepwise == full recompute, certificates valid, edge sets exact.
- Degenerate-inclusive `{0,1}^2` (10 segments incl. zero-length): all 45
  pairs cross-checked, all **120 triples** fully verified.
- Total: **7260 triples** enumerated; `test_enumerate: 79971 checks, 0 failures`.
