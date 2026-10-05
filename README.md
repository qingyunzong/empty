# geom — exact geometric predicates for integer coordinates

C++20 library implementing adaptive `orient2d` / `incircle` predicates:

1. **Float filter** — a double-precision evaluation with Shewchuk's certified
   error bounds answers the easy cases (`used_exact == false`).
2. **Exact integer branch** — when the filter cannot certify the sign, the
   determinant is evaluated exactly: `__int128` when the value provably fits
   (orient: |coord| ≤ 2^62; incircle: |coord| ≤ 2^30), otherwise a pure
   standard-C++20 arbitrary-precision `BigInt` (`include/geom/bigint.hpp`).
3. **Degenerate ID rule** — exactly collinear (orient) or cocircular
   (incircle) inputs are resolved deterministically Simulation-of-Simplicity
   style: the sign is the parity of the permutation sorting the point IDs
   (even → positive, odd → negative; duplicate IDs → zero).

Every call returns `PredicateResult{sign, used_exact}` so callers can audit
whether the exact branch was taken. `orient2d_model` / `incircle_model` are
always-exact arbitrary-precision reference implementations used by the tests
to cross-check the adaptive predicates, including near-collinear and
near-cocircular extremes (Cassini-identity determinants of ±1 with
permanents ~2.6e18; 3-4-5 circles scaled by 2^58).

## Build & test

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
cd build && ctest --output-on-failure
```

See `RESULTS.md` for the recorded test run.
