# geom — robust geometry predicates for integer coordinates

C++20, standard library only. Coordinates are `int64_t` (`geom::Point{id,x,y}`).

## Evaluation tiers

1. **`kFloatFilter`** — double arithmetic with Shewchuk-style error bounds
   (`orient2d`: `(3+16ε)ε`, `incircle`: `(10+96ε)ε`). Used only as a filter:
   it decides only when `|det|` exceeds the bound, and only when all
   coordinates are exactly representable as double (`|coord| ≤ 2^53`).
2. **`kExactI128`** — exact 128-bit integer arithmetic, used when
   `|coord| ≤ 2^29` (no overflow possible: `|orient det| ≤ 2^62`,
   `|incircle det| ≤ 2^124`).
3. **`kExactBigInt`** — arbitrary-precision integers (`geom::BigInt`,
   header-only, standard library only). Always exact; also exposed as
   `orient2d_model` / `incircle_model` ground truth for tests.

Every result reports `method` and `used_exact()`, so callers can tell
whether the exact branch was taken.

## Degeneracy: ID rule

When the exact determinant is zero (collinear / cocircular), the sign is
decided by the parity of the permutation that sorts the point IDs
(Simulation-of-Simplicity style). The rule is deterministic and
antisymmetric: swapping any two arguments flips the sign. Results carry
`degenerate = true` in this case.

## Build & test

```sh
cmake -B build
cmake --build build
ctest --test-dir build --output-on-failure
```
