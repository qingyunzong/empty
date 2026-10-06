import { Conic, ConicInput, evalConic, evalConicInterval, makeConic } from './conic.js';
import { ivContainsZero } from './interval.js';
import { Line, LineInput, evalLine, evalLineInterval, makeLine } from './line.js';
import { Rational } from './rational.js';
import { IntersectionResult, UnivariateQuadratic } from './intersect.js';

/**
 * Back-substitution verification ("代回区间核验").
 *
 *  - none:    the exact discriminant is negative (certificate of emptiness).
 *  - tangent: the exact rational point satisfies both Q(x, y) = 0 and
 *             a x + b y + c = 0 with zero residual.
 *  - secant:  for each point, interval arithmetic over the coordinate box
 *             encloses 0 for both the conic and the line; the restricted
 *             quadratic changes sign across the parameter interval; and the
 *             two parameter intervals are disjoint (each isolates one root).
 */
export function verifyIntersection(
  conicInput: ConicInput | Conic,
  lineInput: LineInput | Line,
  result: IntersectionResult,
): boolean {
  const conic = makeConic(conicInput);
  const line = makeLine(lineInput);

  switch (result.kind) {
    case 'none':
      return result.discriminant < 0n;

    case 'tangent': {
      const { x, y } = result.point;
      return evalConic(conic, x, y).isZero() && evalLine(line, x, y).isZero();
    }

    case 'secant': {
      const quad = result.quadratic;
      const paramIntervals = result.points.map((pt) =>
        quad.variable === 'x' ? pt.x.interval : pt.y.interval,
      );

      const boxesCheckOut = result.points.every(
        (pt) =>
          ivContainsZero(evalConicInterval(conic, pt.x.interval, pt.y.interval)) &&
          ivContainsZero(evalLineInterval(line, pt.x.interval, pt.y.interval)),
      );
      if (!boxesCheckOut) return false;

      const signChanges = paramIntervals.every((iv) => quadSignChange(quad, iv.lo, iv.hi));
      if (!signChanges) return false;

      // Points are emitted in ascending parameter order; intervals must not overlap.
      return paramIntervals[0]!.hi.cmp(paramIntervals[1]!.lo) <= 0;
    }
  }
}

/** Sign change of the integer quadratic across an interval (exact evaluation). */
function quadSignChange(quad: UnivariateQuadratic, lo: Rational, hi: Rational): boolean {
  const evalAt = (t: Rational) =>
    Rational.make(quad.a2).mul(t).mul(t)
      .add(Rational.make(quad.a1).mul(t))
      .add(Rational.make(quad.a0))
      .sign();
  if (lo.cmp(hi) === 0) return evalAt(lo) === 0; // degenerate interval: exact rational root
  const slo = evalAt(lo);
  const shi = evalAt(hi);
  return slo !== 0 && shi !== 0 && slo !== shi;
}
