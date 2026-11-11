# Cube-map sampler

Embeddable, header-only C++ cube-map texture sampler in
`include/cubemap_sampler.hpp` (C++17, no dependencies).

## Conventions

- Six faces in order `+X, -X, +Y, -Y, +Z, -Z` (`cubemap::Face`).
- Face selection picks the direction component with the largest absolute
  value; ties resolve by axis priority **X, then Y, then Z**. The zero
  direction is rejected.
- Each face defines an orthonormal basis `(N, R, U)` — outward normal,
  right, up — where `R × U == N` and every basis vector is a signed unit
  coordinate axis.
- A direction is projected as `d / (d · N)`; face coordinates are the dot
  products with `R` and `U`, both in `[-1, 1]`.
- Face coordinate `q` maps to pixel coordinate
  `x = (q + 1) * size / 2 - 0.5`; the nearest pixel is
  `floor(x + 0.5)` clamped to `[0, size-1]`.
- Bilinear taps that fall outside a face are re-projected from their own
  world direction onto the neighbouring face and read there. Taps are never
  pinned to the original edge (`EdgePolicy::Clamp` exists only for testing).
- All six faces share one square size; storage is supplied externally as
  either one contiguous block or one pointer per face (row-major texels).

## Pixel type

Arithmetic pixel types work out of the box. Custom types provide a static
`mix(const P&, const P&, float)`; see `RGB8` in the test for an example.

## Build and test

```
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

The fixture suite covers the twelve cube seams (24 face edges), all eight
corner footprints (including diagonal taps crossing two edges), single-pixel
faces, zero-direction rejection, tie-break face selection, the exact pixel
mapping, and re-projection versus edge clamping.
