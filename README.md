# rational-ellipse-line-intersection

Exact intersection of a rational ellipse and a rational line (TypeScript, zero
dependencies, BigInt exact arithmetic).

- Ellipse: `A x^2 + B x y + C y^2 + D x + E y + F = 0` with rational coefficients.
  `Ellipse.create` rejects non-ellipses (`B^2-4AC >= 0`), degenerate conics
  (`det = 0`: point ellipse, line pairs, …) and imaginary ellipses (no real locus).
- Line: `a x + b y + c = 0`, rational.
- The line is substituted into the conic giving a rational quadratic; its exact
  discriminant classifies the result:
  - `none` — discriminant < 0;
  - `tangent` — discriminant = 0, rational tangent point, verified exactly
    against both equations;
  - `two` — discriminant > 0, points given in the algebraic form
    `rat + coeff * sqrt(radicand)` together with rational isolating intervals
    (width <= eps, default `2^-20`) produced by exact-sign bisection.
- Every isolating interval is verified by substituting its rational endpoints
  back into the original 2D conic and requiring a sign straddle; intervals of
  the two roots are checked disjoint.

## Usage

```sh
npm test          # build + run the test suite (node:test)
npm run build     # compile to dist/
node dist/src/cli.js A B C D E F -- a b c
# e.g. circle x^2+y^2=4 vs line y=x:
node dist/src/cli.js 1 0 1 0 0 -4 -- 1 -1 0
```

Coefficients are integers or fractions (`-3/4`).

## API

```ts
import { Rat, Ellipse, Line, intersectEllipseLine } from "./src";

const e = Ellipse.create(...(["1","0","4","0","0","-4"].map(Rat.parse) as any));
const l = new Line(Rat.of(3), Rat.of(8), Rat.of(-10));
const res = intersectEllipseLine(e, l); // { kind: "tangent", point: ... }
```
