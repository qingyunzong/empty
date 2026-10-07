# rational-quadratic-aabb

Exact axis-aligned bounding boxes for rational quadratic Bezier curves

  P(t) = ( sum_i w_i B_i(t) p_i ) / ( sum_i w_i B_i(t) ),   t in [0, 1]

with **positive rational weights**. All arithmetic is exact (BigInt-backed
rationals); nothing is ever rounded to a float.

## Guarantees

For each axis the result reports rational intervals such that

  - the true minimum lies in `[min.lo, min.hi]`,
  - the true maximum lies in `[max.lo, max.hi]`,

and therefore `P(t).axis in [min.lo, max.hi]` for every `t in [0, 1]` —
a provable containment box. Interior critical parameters `t*` are the roots
of the derivative numerator `N'D - N D'` (a quadratic with integer
coefficients). Irrational roots are reported as **rational root-isolation
intervals** `[lo, hi]` with `hi - lo <= eps`, obtained from the quadratic
formula with integer-square-root bounds and refined by exact bisection.
Coordinate values at extrema are enclosed by exact Bernstein-basis interval
arithmetic, so the box is conservative and verifiable.

## API

```ts
import { Rat, makeCurve, vec2, rationalQuadraticAABB, containingBox } from "./src/index.js";

const curve = makeCurve(
  vec2(Rat.of(0), Rat.of(0)),
  vec2(Rat.of(1), Rat.of(2)),
  vec2(Rat.of(2), Rat.of(0)),
  Rat.of(1), Rat.of(3, 7), Rat.of(2),   // positive rational weights
);
const box = rationalQuadraticAABB(curve, Rat.of(1, 2 ** 20));
// box.x.min, box.x.max, box.y.min, box.y.max: ValueInterval { lo, hi }
// box.extrema: [{ axis, param: {lo, hi}, value: {lo, hi} }]
const cb = containingBox(box);          // guaranteed outer box
```

## Tests

```
npm test        # tsc + node --test dist/test/*.test.js
npm run typecheck
```

The suite covers endpoint acceptance (monotone curves and curves whose
critical parameter falls outside `(0, 1)` produce exact endpoint boxes),
constant curves (degenerate box, no extrema), exact apex isolation,
irrational-root isolation brackets, and **high-precision rational sampling
containment**: thousands of exactly evaluated rational parameter samples
per curve are checked to lie inside the reported box.
