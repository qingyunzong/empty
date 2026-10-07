# rational_geometry

Exact ray/triangle intersection in C++20 using rational arithmetic
(header-only, no dependencies).

## API

```cpp
#include <geom/ray_triangle.hpp>

geom::Ray ray{origin, dir};            // point = origin + t * dir, t >= 0
geom::Triangle tri{a, b, c};
geom::Hit hit = geom::ray_triangle_intersect(ray, tri);
```

`Hit::kind` is one of:

- `None` — no intersection with `t >= 0`
- `Point` — single hit at parameter `t`
- `Interval` — overlap over `[lo, hi]` (coplanar ray, or ray collinear with
  a degenerate segment triangle)

Semantics:

- Boundary hits (vertex/edge) count as hits.
- All returned parameters are non-negative and fully reduced
  (`gcd(num, den) == 1`, `den > 0`).
- Degenerate triangles (collinear/coincident vertices) degrade to a segment
  or a point; skew/parallel misses are handled exactly.
- A zero-direction ray is treated as a point-in-triangle query.

## Build & test

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

## Layout

- `include/geom/rational.hpp` — exact rational type (128-bit intermediate
  arithmetic, normalized on every operation)
- `include/geom/vec3.hpp` — 3D vector over `Rational` (dot/cross, etc.)
- `include/geom/ray_triangle.hpp` — intersection routine
- `tests/ray_triangle_tests.cpp` — CTest-registered executable covering
  interior/vertex/edge hits, parallel and coplanar rays (interval output),
  and degenerate segment/point triangles
