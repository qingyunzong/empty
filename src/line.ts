import { Rational, RationalInput } from './rational.js';
import { RationalInterval, ivAdd, ivConst, ivScale } from './interval.js';

/** Line  a x + b y + c = 0  with exact rational coefficients, (a, b) != (0, 0). */
export interface Line {
  readonly a: Rational;
  readonly b: Rational;
  readonly c: Rational;
}

export type LineInput = {
  readonly [K in 'a' | 'b' | 'c']: RationalInput;
};

export class LineError extends Error {
  override readonly name: string = 'LineError';
}

export function makeLine(input: LineInput | Line): Line {
  const line = {
    a: Rational.from(input.a),
    b: Rational.from(input.b),
    c: Rational.from(input.c),
  };
  if (line.a.isZero() && line.b.isZero()) {
    throw new LineError('degenerate line: a and b cannot both be zero');
  }
  return line;
}

/** Exact evaluation a x + b y + c at a rational point. */
export function evalLine(l: Line, x: Rational, y: Rational): Rational {
  return l.a.mul(x).add(l.b.mul(y)).add(l.c);
}

/** Interval enclosure of the line form over a box. */
export function evalLineInterval(l: Line, x: RationalInterval, y: RationalInterval): RationalInterval {
  return ivAdd(ivAdd(ivScale(l.a, x), ivScale(l.b, y)), ivConst(l.c));
}
