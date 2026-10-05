"""Root isolation by exact interval arithmetic.

Strategy per interval I (all evaluations exact, rational):
  1. 0 not in f(I)                     -> "none"
  2. midpoint is a true domain hole    -> "undecided" hole point, split
  3. midpoint is a true root           -> "unique" (if certifiable) else
                                          "undecided" point, split
  4. 0 not in f'(I), no holes: endpoint sign rule (finite endpoints):
       f(lo)*f(hi) < 0                 -> "unique" (IVT + monotonicity)
       same strict sign                -> "none"
       zero only at an open endpoint   -> "none"
       zero at a closed endpoint       -> "unique" point
     otherwise interval Newton contraction, bisection on no progress
  5. otherwise bisect

Budget exhaustion emits "undecided" for everything left; undecided
outputs are never dropped.
"""

from fractions import Fraction

from .intervals import (Interval, mkset, sinter, scontains_zero, ssubset,
                        sadd, sneg, sdiv, is_inf, elt)
from .expr import derive

NONE = "none"
UNIQUE = "unique"
UNDECIDED = "undecided"

_ZERO_SET = mkset([Interval.point(Fraction(0))])


class Output:
    def __init__(self, interval, label, chain, proof):
        self.interval = interval
        self.label = label
        self.chain = list(chain)
        self.proof = dict(proof)

    def __repr__(self):
        return "Output(%r, %s)" % (self.interval, self.label)


def _mid(i):
    if is_inf(i.lo) and is_inf(i.hi):
        return Fraction(0)
    if is_inf(i.lo):
        return i.hi - 1
    if is_inf(i.hi):
        return i.lo + 1
    return (i.lo + i.hi) / 2


def _bisect(work, i, m, chain):
    # Half-open split: a root exactly at m belongs to the left half only.
    left = Interval(i.lo, m, i.lc, True)
    right = Interval(m, i.hi, False, i.hc)
    work.append((right, chain + [right]))
    work.append((left, chain + [left]))


def _split_open(work, i, m, chain):
    # Exclude the point m itself (already reported): both sides open at m.
    if elt(i.lo, m):
        left = Interval(i.lo, m, i.lc, False)
        work.append((left, chain + [left]))
    if elt(m, i.hi):
        right = Interval(m, i.hi, False, i.hc)
        work.append((right, chain + [right]))


def _point_value(env, f, var, v):
    """Exact value of f at the rational point v, or None if not a
    singleton / undefined."""
    res, hole = env.eval_at(f, var, mkset([Interval.point(v)]))
    if hole or len(res) != 1 or not res[0].is_point():
        return None
    return res[0].lo


def _endpoint_decide(env, f, var, i, chain, outs, work):
    """Decide I by exact endpoint signs.  Only called when 0 is not in
    f'(I) and neither f nor f' has a hole on I (strict monotonicity).
    Returns True if I was decided."""
    vlo = _point_value(env, f, var, i.lo)
    vhi = _point_value(env, f, var, i.hi)
    if vlo is None or vhi is None:
        return False
    if vlo == 0:
        if i.lc:
            pt = Interval.point(i.lo)
            outs.append(Output(pt, UNIQUE, chain + [pt],
                               {"kind": "point", "m": i.lo, "scope": i}))
            if elt(i.lo, i.hi):
                rest = Interval(i.lo, i.hi, False, i.hc)
                work.append((rest, chain + [rest]))
        else:
            outs.append(Output(i, NONE, chain,
                               {"kind": "endpoint_root_excluded",
                                "scope": i}))
        return True
    if vhi == 0:
        if i.hc:
            pt = Interval.point(i.hi)
            outs.append(Output(pt, UNIQUE, chain + [pt],
                               {"kind": "point", "m": i.hi, "scope": i}))
            if elt(i.lo, i.hi):
                rest = Interval(i.lo, i.hi, i.lc, False)
                work.append((rest, chain + [rest]))
        else:
            outs.append(Output(i, NONE, chain,
                               {"kind": "endpoint_root_excluded",
                                "scope": i}))
        return True
    if (vlo < 0) != (vhi < 0):
        outs.append(Output(i, UNIQUE, chain,
                           {"kind": "sign_change", "scope": i}))
    else:
        outs.append(Output(i, NONE, chain,
                           {"kind": "no_sign_change", "scope": i}))
    return True


def isolate(ctx, env, f, var, domain, budget=1000):
    df = derive(ctx, f, var)
    work = [(i, [i]) for i in domain]
    outs = []
    steps = 0
    while work:
        if steps >= budget:
            break
        i, chain = work.pop()
        steps += 1
        iset = mkset([i])
        env.set_var(var, iset)
        fres, fhole = env.eval(f)
        if not scontains_zero(fres):
            outs.append(Output(i, NONE, chain, {"kind": "excludes_zero"}))
            continue
        dfres, dfhole = env.eval(df)
        m = _mid(i)
        fm, fmhole = env.eval_at(f, var, mkset([Interval.point(m)]))
        if fmhole:
            # Point evaluation is exact: m is a true domain hole.
            pt = Interval.point(m)
            outs.append(Output(pt, UNDECIDED, chain + [pt],
                               {"kind": "domain_hole", "m": m}))
            _split_open(work, i, m, chain)
            continue
        if fm == _ZERO_SET:
            # m is a true root (exact point evaluation).
            pt = Interval.point(m)
            mono = (not fhole) and (not dfhole) and \
                not scontains_zero(dfres)
            if not mono:
                # Pointwise fallback: f'(m) is exact, nonzero certifies a
                # simple root.
                dfm, dfmh = env.eval_at(df, var, mkset([pt]))
                mono = not dfmh and not scontains_zero(dfm)
                scope = pt
            else:
                scope = i
            if mono:
                outs.append(Output(pt, UNIQUE, chain + [pt],
                                   {"kind": "point", "m": m,
                                    "scope": scope}))
            else:
                outs.append(Output(pt, UNDECIDED, chain + [pt],
                                   {"kind": "unresolved_root", "m": m}))
            _split_open(work, i, m, chain)
            continue
        if (not fhole) and (not dfhole) and not scontains_zero(dfres):
            if not is_inf(i.lo) and not is_inf(i.hi) and \
                    _endpoint_decide(env, f, var, i, chain, outs, work):
                continue
            # Interval Newton step: N = m - f(m)/f'(I).
            n, _ = sdiv(fm, dfres)
            n = sadd(mkset([Interval.point(m)]), sneg(n))
            i2 = sinter(iset, n)
            if not i2:
                outs.append(Output(i, NONE, chain,
                                   {"kind": "newton_empty", "m": m,
                                    "scope": i}))
                continue
            if len(i2) == 1 and i2[0] == i:
                _bisect(work, i, m, chain)  # no progress
                continue
            if len(i2) == 1 and ssubset(n, iset):
                # N(I) subseteq I and 0 not in f'(I): unique root in N.
                outs.append(Output(i2[0], UNIQUE, chain + [i2[0]],
                                   {"kind": "newton", "m": m, "scope": i}))
                continue
            for j in i2:
                work.append((j, chain + [j]))
            continue
        _bisect(work, i, m, chain)
    for i, chain in work:
        outs.append(Output(i, UNDECIDED, chain, {"kind": "budget"}))
    return outs
