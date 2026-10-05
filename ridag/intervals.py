"""Exact rational interval arithmetic.

Intervals have rational endpoints (fractions.Fraction) with independent
open/closed flags, and may be unbounded (endpoints at +/- infinity, always
open).  An interval *set* is a canonical sorted tuple of disjoint intervals;
division by a set containing zero splits into a union of rays instead of
collapsing to the whole real line, so structural information is preserved.
"""

from fractions import Fraction

Z = Fraction(0)


class _Inf:
    __slots__ = ("s",)

    def __init__(self, s):
        self.s = s

    def __repr__(self):
        return "inf" if self.s > 0 else "-inf"


MINF = _Inf(-1)
PINF = _Inf(1)


def is_inf(v):
    return v is MINF or v is PINF


def _key(v):
    if v is MINF:
        return (0, Z)
    if v is PINF:
        return (2, Z)
    return (1, v)


def elt(a, b):
    return _key(a) < _key(b)


def ele(a, b):
    return _key(a) <= _key(b)


def emin(a, b):
    return a if ele(a, b) else b


def emax(a, b):
    return a if ele(b, a) else b


def eneg(v):
    if v is MINF:
        return PINF
    if v is PINF:
        return MINF
    return -v


def eadd(a, b):
    if a is MINF or a is PINF:
        return a
    if b is MINF or b is PINF:
        return b
    return a + b


def emul(a, b):
    # Never called with 0 * infinity (sign-split parts guarantee this).
    if a is MINF or a is PINF:
        if b is MINF or b is PINF:
            return PINF if (a is PINF) == (b is PINF) else MINF
        assert b != 0
        return a if b > 0 else eneg(a)
    if b is MINF or b is PINF:
        assert a != 0
        return b if a > 0 else eneg(b)
    return a * b


def epow(v, n):
    if v is MINF:
        return PINF if n % 2 == 0 else MINF
    if v is PINF:
        return PINF
    return v ** n


def eabs(v):
    if is_inf(v):
        return PINF
    return abs(v)


class Interval:
    __slots__ = ("lo", "hi", "lc", "hc")

    def __init__(self, lo, hi, lc=True, hc=True):
        if is_inf(lo):
            lc = False
        if is_inf(hi):
            hc = False
        assert elt(lo, hi) or (lo == hi and not is_inf(lo) and lc and hc), \
            "bad interval %r %r" % (lo, hi)
        self.lo = lo
        self.hi = hi
        self.lc = bool(lc)
        self.hc = bool(hc)

    @staticmethod
    def point(v):
        return Interval(v, v, True, True)

    def contains(self, v):
        return (elt(self.lo, v) or (v == self.lo and self.lc)) and \
               (elt(v, self.hi) or (v == self.hi and self.hc))

    def is_point(self):
        return self.lo == self.hi

    def width(self):
        if is_inf(self.lo) or is_inf(self.hi):
            return None
        return self.hi - self.lo

    def __eq__(self, other):
        return isinstance(other, Interval) and \
            (self.lo, self.hi, self.lc, self.hc) == \
            (other.lo, other.hi, other.lc, other.hc)

    def __hash__(self):
        return hash((self.lo, self.hi, self.lc, self.hc))

    def __repr__(self):
        return "%s%r, %r%s" % ("[" if self.lc else "(", self.lo,
                               self.hi, "]" if self.hc else ")")


EMPTY = ()


def mkset(ivs):
    """Canonicalize: sort and merge overlapping/touching intervals."""
    ivs = sorted(ivs, key=lambda i: (_key(i.lo), not i.lc))
    out = []
    for i in ivs:
        if out and (elt(i.lo, out[-1].hi) or
                    (i.lo == out[-1].hi and (i.lc or out[-1].hc))):
            cur = out[-1]
            if elt(cur.hi, i.hi):
                out[-1] = Interval(cur.lo, i.hi, cur.lc, i.hc)
            elif cur.hi == i.hi:
                out[-1] = Interval(cur.lo, cur.hi, cur.lc, cur.hc or i.hc)
        else:
            out.append(i)
    return tuple(out)


def sunion(a, b):
    return mkset(list(a) + list(b))


def sinter(a, b):
    out = []
    for i in a:
        for j in b:
            lo = emax(i.lo, j.lo)
            hi = emin(i.hi, j.hi)
            if elt(hi, lo):
                continue
            if lo == i.lo and lo == j.lo:
                lc = i.lc and j.lc
            elif lo == i.lo:
                lc = i.lc
            else:
                lc = j.lc
            if hi == i.hi and hi == j.hi:
                hc = i.hc and j.hc
            elif hi == i.hi:
                hc = i.hc
            else:
                hc = j.hc
            if lo == hi and not (lc and hc):
                continue
            out.append(Interval(lo, hi, lc, hc))
    return mkset(out)


def sneg(s):
    return mkset([Interval(eneg(i.hi), eneg(i.lo), i.hc, i.lc) for i in s])


def sadd(a, b):
    return mkset([Interval(eadd(i.lo, j.lo), eadd(i.hi, j.hi),
                           i.lc and j.lc, i.hc and j.hc)
                  for i in a for j in b])


def ssub(a, b):
    return sadd(a, sneg(b))


def _parts(i):
    """Split into (sign, interval) parts: negative, {0}, positive."""
    res = []
    if elt(i.lo, Z):
        if elt(i.hi, Z):
            res.append((-1, Interval(i.lo, i.hi, i.lc, i.hc)))
        else:
            res.append((-1, Interval(i.lo, Z, i.lc, False)))
    if i.contains(Z):
        res.append((0, Interval.point(Z)))
    if elt(Z, i.hi):
        if elt(Z, i.lo):
            res.append((1, Interval(i.lo, i.hi, i.lc, i.hc)))
        else:
            res.append((1, Interval(Z, i.hi, False, i.hc)))
    return res


def _imul1(p, sp, q, sq):
    if sp == 0 or sq == 0:
        return Interval.point(Z)
    if sp == sq:
        if sp > 0:
            lo = (p.lo, p.lc, q.lo, q.lc)
            hi = (p.hi, p.hc, q.hi, q.hc)
        else:
            lo = (p.hi, p.hc, q.hi, q.hc)
            hi = (p.lo, p.lc, q.lo, q.lc)
    elif sp > 0:
        lo = (p.hi, p.hc, q.lo, q.lc)
        hi = (p.lo, p.lc, q.hi, q.hc)
    else:
        lo = (p.lo, p.lc, q.hi, q.hc)
        hi = (p.hi, p.hc, q.lo, q.lc)
    lov = emul(lo[0], lo[2])
    hiv = emul(hi[0], hi[2])
    return Interval(lov, hiv, lo[1] and lo[3], hi[1] and hi[3])


def smul(a, b):
    out = []
    for i in a:
        for j in b:
            for sp, p in _parts(i):
                for sq, q in _parts(j):
                    out.append(_imul1(p, sp, q, sq))
    return mkset(out)


def srecip(s):
    """Reciprocal; returns (set, hole).  A zero part is a domain hole and
    splits the result into rays instead of the whole real line."""
    out = []
    hole = False
    for i in s:
        for sp, p in _parts(i):
            if sp == 0:
                hole = True
            elif sp < 0:
                lo = MINF if p.hi == Z else Fraction(1) / p.hi
                hi = Z if p.lo is MINF else Fraction(1) / p.lo
                out.append(Interval(lo, hi, p.hc, p.lc))
            else:
                lo = Z if p.hi is PINF else Fraction(1) / p.hi
                hi = PINF if p.lo == Z else Fraction(1) / p.lo
                out.append(Interval(lo, hi, p.hc, p.lc))
    return mkset(out), hole


def sdiv(a, b):
    r, hole = srecip(b)
    return smul(a, r), hole


def _ipow_part(p, n):
    # p is a nonzero-sign part, n >= 1.
    if n % 2 == 1:
        return Interval(epow(p.lo, n), epow(p.hi, n), p.lc, p.hc)
    al, ah = eabs(p.lo), eabs(p.hi)
    if ele(al, ah):
        small, big, sc, bc = p.lo, p.hi, p.lc, p.hc
    else:
        small, big, sc, bc = p.hi, p.lo, p.hc, p.lc
    lo = epow(eabs(small), n)
    hi = epow(eabs(big), n)
    return Interval(lo, hi, sc if lo != Z else False, bc)


def spow(s, n):
    """Integer power; returns (set, hole).  Negative exponents treat 0 as
    a domain hole."""
    n = int(n)
    if n == 0:
        return mkset([Interval.point(Fraction(1))]), False
    if n < 0:
        pos, _ = spow(s, -n)
        return srecip(pos)
    out = []
    for i in s:
        for sp, p in _parts(i):
            if sp == 0:
                out.append(Interval.point(Z))
            else:
                out.append(_ipow_part(p, n))
    return mkset(out), False


def scontains_zero(s):
    return any(i.contains(Z) for i in s)


def all_positive(s):
    return len(s) > 0 and \
        all(elt(Z, i.lo) or (i.lo == Z and not i.lc) for i in s)


def all_negative(s):
    return len(s) > 0 and \
        all(elt(i.hi, Z) or (i.hi == Z and not i.hc) for i in s)


def iv_subset(inner, outer):
    if not ele(outer.lo, inner.lo) or not ele(inner.hi, outer.hi):
        return False
    if inner.lo == outer.lo and inner.lc and not outer.lc:
        return False
    if inner.hi == outer.hi and inner.hc and not outer.hc:
        return False
    return True


def ssubset(a, b):
    return all(any(iv_subset(i, j) for j in b) for i in a)
