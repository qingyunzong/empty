import { Fraction } from "./fraction";
import { Poly, evalAt, mobius, signVariations } from "./poly";

export interface Interval {
  lo: Fraction;
  hi: Fraction;
}

export interface IsolationOptions {
  /** Max number of Descartes sign-variation evaluations (bisection nodes). */
  budget: number;
  /** Isolating intervals are refined until width <= 2^-refineBits. */
  refineBits: number;
}

export interface IsolationResult {
  roots: Interval[];
  unknown: Interval[];
  nodesUsed: number;
}

/**
 * Isolates all roots of a square-free polynomial f in the open interval
 * (0, 1) using exact Descartes' rule of signs with bisection over dyadic
 * rationals. No sampling: root counts come from exact sign-variation
 * counts of Mobius-transformed polynomials.
 *
 * Roots landing exactly on a dyadic midpoint are reported as degenerate
 * intervals [m, m]. If the node budget is exhausted before all intervals
 * resolve, the unresolved intervals are reported as unknown.
 */
export function isolateRoots(f: Poly, opts: IsolationOptions): IsolationResult {
  const roots: Interval[] = [];
  const unknown: Interval[] = [];
  let nodes = 0;
  const zero = Fraction.ZERO;
  const one = Fraction.ONE;
  const two = Fraction.of(2);
  const minWidth = Fraction.of(1, 2n ** BigInt(Math.max(0, opts.refineBits)));

  const stack: Interval[] = [{ lo: zero, hi: one }];
  while (stack.length > 0) {
    const { lo, hi } = stack.pop()!;
    if (nodes >= opts.budget) {
      unknown.push({ lo, hi });
      continue;
    }
    nodes++;
    const v = signVariations(mobius(f, lo, hi));
    if (v === 0) continue;
    if (v === 1 && hi.sub(lo).cmp(minWidth) <= 0) {
      roots.push({ lo, hi });
      continue;
    }
    const m = lo.add(hi).div(two);
    if (evalAt(f, m).isZero()) {
      roots.push({ lo: m, hi: m });
    }
    stack.push({ lo, hi: m }, { lo: m, hi });
  }

  roots.sort((p, q) => p.lo.cmp(q.lo));
  unknown.sort((p, q) => p.lo.cmp(q.lo));
  return { roots, unknown, nodesUsed: nodes };
}
