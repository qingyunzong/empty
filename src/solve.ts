import { Rat } from "./rational";
import {
  Poly,
  deriv,
  divExact,
  evalPoly,
  gcdPoly,
  isZeroPoly,
  multiplicityAt,
  trim,
} from "./poly";
import { bernsteinToPower, powerToBernstein, signVariation, subdivideHalf } from "./bezier";

export const MAX_SEGMENTS = 8;

export interface Line {
  a: Rat;
  b: Rat;
  c: Rat;
}

export interface RootOut {
  segment: number;
  multiplicity: number;
  exact: boolean;
  t: [string, string];
  globalT: [string, string];
}

export interface OnLineOut {
  segment: number;
  t: [string, string];
  globalT: [string, string];
}

export interface UnknownOut {
  segment: number;
  t: [string, string];
  globalT: [string, string];
  maxRoots: number;
}

export interface SolveResult {
  roots: RootOut[];
  onLine: OnLineOut[];
  unknown: UnknownOut[];
  budget: { limit: number; used: number; closed: boolean };
}

export interface SolveOptions {
  /** Total number of isolation nodes the solver may visit across all segments. */
  budget?: number;
  /** Isolation stops refining a single-root interval once its width is <= tol. */
  tol?: Rat;
}

const DEFAULT_BUDGET = 100000;
const DEFAULT_TOL = Rat.of(1n, 2n ** 24n);

interface Node {
  coeffs: Rat[];
  lo: Rat;
  hi: Rat;
}

interface RootInternal {
  segment: number;
  lo: Rat;
  hi: Rat;
  multiplicity: number;
  exact: boolean;
}

export function solve(
  segments: [Rat, Rat][][],
  line: Line,
  opts: SolveOptions = {},
): SolveResult {
  if (segments.length < 1 || segments.length > MAX_SEGMENTS) {
    throw new Error(`expected 1..${MAX_SEGMENTS} segments, got ${segments.length}`);
  }
  for (const seg of segments) {
    if (seg.length !== 4) throw new Error("each cubic segment needs exactly 4 control points");
  }
  if (line.a.isZero() && line.b.isZero()) throw new Error("degenerate line: a and b both zero");

  const budgetLimit = opts.budget ?? DEFAULT_BUDGET;
  const tol = opts.tol ?? DEFAULT_TOL;
  let used = 0;
  let exhausted = false;

  const roots: RootInternal[] = [];
  const onLine: OnLineOut[] = [];
  const unknown: UnknownOut[] = [];

  const zero = Rat.zero();
  const one = Rat.one();

  const pushUnknown = (segment: number, lo: Rat, hi: Rat, maxRoots: number) => {
    unknown.push({
      segment,
      maxRoots,
      t: [lo.toString(), hi.toString()],
      globalT: [lo.add(Rat.of(segment)).toString(), hi.add(Rat.of(segment)).toString()],
    });
  };

  for (let seg = 0; seg < segments.length; seg++) {
    const pts = segments[seg]!;
    // Implicit line evaluated on the curve: Bernstein coefficients of f(t) = a*x(t)+b*y(t)+c.
    const bc = pts.map(([x, y]) => line.a.mul(x).add(line.b.mul(y)).add(line.c));

    const f = bernsteinToPower(bc);
    if (isZeroPoly(f)) {
      onLine.push({ segment: seg, t: ["0", "1"], globalT: [`${seg}`, `${seg + 1}`] });
      continue;
    }

    // Repeated roots: shared roots of f and f'. For a cubic these are always rational,
    // so they are computed exactly instead of isolated.
    const g = gcdPoly(f, deriv(f));
    const repeated: { r: Rat; m: number }[] = [];
    if (g.length === 2) {
      repeated.push({ r: g[0]!.neg().div(g[1]!), m: 0 });
    } else if (g.length === 3) {
      // g must be a perfect square (t - r)^2 with rational r.
      const r = g[1]!.neg().div(g[2]!.mul(Rat.of(2n)));
      if (!evalPoly(g, r).isZero()) throw new Error("internal: unexpected gcd structure");
      repeated.push({ r, m: 0 });
    }
    let h: Poly = trim(f);
    for (const rep of repeated) {
      rep.m = multiplicityAt(f, rep.r);
      const linear: Poly = [rep.r.neg(), Rat.one()];
      for (let i = 0; i < rep.m; i++) h = divExact(h, linear);
      if (zero.lte(rep.r) && rep.r.lte(one)) {
        roots.push({ segment: seg, lo: rep.r, hi: rep.r, multiplicity: rep.m, exact: true });
      }
    }

    // h now contains only simple roots of f. Isolate them in [0, 1] via exact
    // Bernstein sign-variation bisection (Descartes' rule; never sampling).
    if (h.length > 1) {
      if (evalPoly(h, zero).isZero())
        roots.push({ segment: seg, lo: zero, hi: zero, multiplicity: 1, exact: true });
      if (evalPoly(h, one).isZero())
        roots.push({ segment: seg, lo: one, hi: one, multiplicity: 1, exact: true });

      const hb = powerToBernstein(h, h.length - 1);
      const stack: Node[] = [{ coeffs: hb, lo: zero, hi: one }];

      while (stack.length > 0) {
        if (used >= budgetLimit) {
          exhausted = true;
          for (const node of stack) {
            pushUnknown(seg, node.lo, node.hi, signVariation(node.coeffs));
          }
          break;
        }
        const node = stack.pop()!;
        used++;
        const v = signVariation(node.coeffs);
        if (v === 0) continue;
        const width = node.hi.sub(node.lo);
        if (v === 1 && width.lte(tol)) {
          roots.push({ segment: seg, lo: node.lo, hi: node.hi, multiplicity: 1, exact: false });
          continue;
        }
        const mid = node.lo.add(node.hi).div(Rat.of(2n));
        if (evalPoly(h, mid).isZero()) {
          roots.push({ segment: seg, lo: mid, hi: mid, multiplicity: 1, exact: true });
        }
        const [cl, cr] = subdivideHalf(node.coeffs);
        stack.push({ coeffs: cr, lo: mid, hi: node.hi });
        stack.push({ coeffs: cl, lo: node.lo, hi: mid });
      }
    }

    if (exhausted) {
      // Remaining segments are reported wholesale as unknown.
      for (let rest = seg + 1; rest < segments.length; rest++) {
        const rpts = segments[rest]!;
        const rbc = rpts.map(([x, y]) => line.a.mul(x).add(line.b.mul(y)).add(line.c));
        if (rbc.every((c) => c.isZero())) {
          onLine.push({ segment: rest, t: ["0", "1"], globalT: [`${rest}`, `${rest + 1}`] });
        } else {
          pushUnknown(rest, zero, one, Math.min(3, signVariation(rbc)));
        }
      }
      break;
    }
  }

  roots.sort((p, q) => {
    const pa = p.lo.add(Rat.of(p.segment));
    const qa = q.lo.add(Rat.of(q.segment));
    return pa.cmp(qa);
  });

  return {
    roots: roots.map((r) => ({
      segment: r.segment,
      multiplicity: r.multiplicity,
      exact: r.exact,
      t: [r.lo.toString(), r.hi.toString()],
      globalT: [
        r.lo.add(Rat.of(r.segment)).toString(),
        r.hi.add(Rat.of(r.segment)).toString(),
      ],
    })),
    onLine,
    unknown,
    budget: { limit: budgetLimit, used, closed: !exhausted },
  };
}
