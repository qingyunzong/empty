# intmesh

Integer triangle-mesh library (C++20, standard library only).

## Features

- **Integer vertices and triangles** — vertices are `Vec3i` (`int64_t`
  components), faces are triples of vertex indices.
- **Exact unnormalized normals** — face normals are exact integer cross
  products; group normals are plain sums of the face normals in each
  group. Nothing is ever normalized or rounded.
- **Diagnostics** — `Mesh::diagnostics()` reports:
  - duplicate edges: the same directed edge used more than once
    (duplicated faces / inconsistent winding) or an edge shared by 3+
    faces (non-manifold);
  - zero-area faces: faces whose exact integer normal is the zero
    vector (collinear or repeated vertices).
- **Incremental updates** — `Mesh::moveVertex(v, delta)` recomputes
  only the faces adjacent to `v` and adjusts the affected group
  aggregates by (new − old) face normals. O(adjacent faces).
- **Lifetime-safe snapshots** — `Mesh::snapshot()` is a cheap read-only
  view backed by chunked copy-on-write storage
  (`PersistentVector`). Later mutations and even destruction of the
  mesh never affect existing snapshots.
- **Independent verification** — `Mesh::verifyConsistency()`
  recomputes every face and group normal from scratch and returns any
  mismatch with the incrementally maintained caches (empty = consistent).

## Precision contract

Cross products are computed with well-defined modular arithmetic and
are exact whenever the true result fits in `int64_t`; this is
guaranteed for input coordinates with `|c| <= 2^30`.

## Build and test

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build -j
cd build && ctest --output-on-failure
```

Sanitizer build (ASan + UBSan):

```sh
cmake -S . -B build-san -DINTMESH_SANITIZE=ON
cmake --build build-san -j
cd build-san && ctest --output-on-failure
```

See `RESULTS.md` for the recorded test output.

## Layout

- `include/intmesh/vec3i.hpp` — integer vector + exact cross product
- `include/intmesh/persistent_vector.hpp` — chunked copy-on-write vector
- `include/intmesh/mesh.hpp`, `src/mesh.cpp` — mesh, diagnostics,
  incremental updates, snapshots, verification
- `tests/` — CTest-registered test executables
