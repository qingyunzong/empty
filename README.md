# rational-quadratic-bezier-aabb

Exact, certified axis-aligned bounding boxes (AABB) for rational quadratic
Bezier curves

```
B(t) = ( w0 (1-t)^2 P0 + 2 w1 (1-t) t P1 + w2 t^2 P2 ) / ( w0 (1-t)^2 + 2 w1 (1-t) t + w2 t^2 ),   t in [0, 1]
```

with **positive rational weights**. All arithmetic is exact rational
arithmetic on `BigInt`; no floating point is ever used internally.

## How it works

- For each coordinate, the extremum parameters are the roots of the exact
  derivative numerator `N'(t) D(t) - N(t) D'(t)`, a polynomial of degree <= 2
  with rational coefficients.
- Rational roots are computed exactly. Irrational roots are enclosed by
  **rational root-isolation bounds** `[lo, hi]` (via exact integer square
  roots), with `hi - lo <= 2^-precisionBits` (default 256 bits). These are
  *verifiable parameter intervals*: the derivative numerator changes sign
  across `[lo, hi]`, which the test suite checks for every reported extremum.
- Each candidate parameter interval (both endpoints `t = 0, 1` plus every
  isolated interior root clamped to `[0, 1]`) is evaluated with conservative
  rational interval arithmetic, yielding a certified rational enclosure of
  the coordinate range. The AABB is the union of these enclosures.
- Endpoint-only (monotone) curves and constant curves are handled as
  degenerate cases of the same pipeline.

## Usage

```ts
import { rationalQuadraticAABB, evaluateRationalQuadratic } from "rational-quadratic-bezier-aabb";

const box = rationalQuadraticAABB(
  { x: 0, y: 0 },
  { x: 1, y: 1 },
  { x: 2, y: 0 },
  [1, 2, 3],              // positive rational weights
  { precisionBits: 256 }, // optional
);

box.x.lo; // Fraction, certified lower bound of x
box.y.hi; // Fraction, certified upper bound of y
box.extrema; // [{ axis, kind: "endpoint" | "interior", t: {lo, hi}, value: {lo, hi} }, ...]

// Exact evaluation at any rational parameter (for verification):
const q = evaluateRationalQuadratic({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }, [1, 2, 3], "1/3");
```

Inputs accept `Fraction`, `bigint`, integer/decimal numbers, or strings such
as `"3/4"`, `"1.25"`, `"1.5e-3"`.

## Tests

```
npm test
```

Compiles with `tsc` and runs `node --test`. The suite covers exact rational
extrema, endpoint acceptance, constant curves, weight validation, IVT
certificates for irrational root-isolation intervals, and containment +
tightness of the box against high-precision (40-bit dyadic) exact rational
sampling of random curves.
