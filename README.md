# curve2d — exact 2D polyline intersection library

C++20 (standard library only) library that maintains a set of 2D polyline
edges and reports their pairwise intersections exactly:

- **Point intersections** with rational coordinates (`curve2d::Rational`,
  normalized `__int128` numerator/denominator — no floating point anywhere).
- **Collinear overlap segments**, endpoints always being original integer
  endpoints.
- **Deduplication**: identical points / overlaps are merged; each reported
  item keeps the sorted set of its *source edges* — every edge passing
  through the point or covering the overlap.
- **Batch updates**: `CurveLibrary::applyBatch(adds, removes)` recomputes
  only pairs touching changed edges; `result()` is exactly equal to
  `fullRecompute()` over all current edge pairs.
- **Certificates**: `verifyIntersections()` checks every reported item
  against the edge set with exact arithmetic.

## Layout

- `include/curve2d/rational.hpp` — exact rational arithmetic
- `include/curve2d/geometry.hpp` — points, segments, exact pair intersection
- `include/curve2d/library.hpp` — incremental edge-set + dedup indices
- `include/curve2d/certificate.hpp` — exact result verification
- `src/geometry.cpp`, `src/library.cpp` — implementations
- `tests/` — CTest suite (see `RESULTS.md` for recorded results)

## Build & test

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
cd build && ctest --output-on-failure
```

## Notes / limitations

- Intermediate exact arithmetic uses `__int128`; endpoint coordinates should
  stay well inside `int64_t` (the acceptance suite uses small coordinates).
- Degenerate (zero-length) edges are supported.
