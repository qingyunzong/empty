"""Algebraic numbers as (squarefree polynomial, isolating interval/point).

Comparison of numbers coming from *different* polynomials is decided by
GCD and joint isolation, never by comparing interval midpoints:

* g = gcd(f_a, f_b).  If g is nonconstant, each number is matched against
  the sorted, separated isolating intervals of g's roots; equal indices
  mean equal numbers.
* Otherwise (or when the numbers are not roots of g) the two isolating
  intervals are refined until they are disjoint, which decides the order.
"""

from fractions import Fraction

from . import poly as P
from .isolate import isolate_squarefree, refine_root_step
from .sturm import count_roots_open, sturm_sequence


class AlgebraicNumber:
    """One real root of a squarefree polynomial, exactly located."""

    def __init__(self, factor, multiplicity, kind, lo, hi=None):
        self.factor = factor
        self.multiplicity = multiplicity
        self.kind = kind
        if kind == "point":
            hi = lo
        self.lo = Fraction(lo)
        self.hi = Fraction(hi)

    @classmethod
    def from_root_record(cls, factors, root):
        f, m = factors[root["factor"]]
        return cls(f, m, root["kind"], root["lo"], root["hi"])

    @classmethod
    def from_polynomial(cls, coeffs, kind, lo, hi=None):
        """Locate the root of ``coeffs`` described by a point or interval."""
        _, facs = P.squarefree_factors(coeffs)
        for f, m in facs:
            if P.degree(f) < 1:
                continue
            if kind == "point":
                if P.evaluate(f, lo) == 0:
                    return cls(f, m, "point", lo)
            else:
                lo, hi = Fraction(lo), Fraction(hi)
                if not lo < hi:
                    raise ValueError("interval must satisfy lo < hi")
                if P.evaluate(f, lo) != 0 and P.evaluate(f, hi) != 0:
                    st = sturm_sequence(f)
                    if count_roots_open(st, f, lo, hi) == 1:
                        return cls(f, m, "interval", lo, hi)
        raise ValueError("no root of the polynomial matches the specification")

    def is_point(self):
        return self.kind == "point"

    def refine_step(self):
        """Narrow the isolating interval by one bisection (in place)."""
        if self.kind == "point":
            return
        st = sturm_sequence(self.factor)
        root = refine_root_step(self.factor, st, {
            "kind": "interval", "lo": self.lo, "hi": self.hi,
            "factor": 0, "multiplicity": self.multiplicity})
        self.kind, self.lo, self.hi = root["kind"], root["lo"], root["hi"]

    def to_dict(self):
        from .jsonutil import enc_frac, enc_poly
        out = {"kind": self.kind, "multiplicity": self.multiplicity,
               "factor": enc_poly(self.factor)}
        if self.kind == "point":
            out["value"] = enc_frac(self.lo)
        else:
            out["lo"] = enc_frac(self.lo)
            out["hi"] = enc_frac(self.hi)
        return out


def _contains(j, r):
    if j["kind"] == "point":
        return j["lo"] == r
    return j["lo"] < r < j["hi"]


def _locate_in(an, g):
    """Index of an's root among the sorted roots of squarefree g, or None."""
    js = isolate_squarefree(g)
    if an.kind == "point":
        if P.evaluate(g, an.lo) != 0:
            return None
        for idx, j in enumerate(js):
            if _contains(j, an.lo):
                return idx
        return None
    st = sturm_sequence(g)
    if count_roots_open(st, g, an.lo, an.hi) == 0:
        return None
    while True:
        hits = [idx for idx, j in enumerate(js)
                if an.lo < j["hi"] and j["lo"] < an.hi]
        if len(hits) == 1:
            return hits[0]
        an.refine_step()


def _order(a, b):
    """Order two algebraic numbers known to be distinct."""
    while True:
        if a.kind == "point" and b.kind == "point":
            return -1 if a.lo < b.lo else (1 if a.lo > b.lo else 0)
        if a.kind == "point":
            if a.lo <= b.lo:
                return -1
            if a.lo >= b.hi:
                return 1
            b.refine_step()
        elif b.kind == "point":
            if b.lo <= a.lo:
                return 1
            if b.lo >= a.hi:
                return -1
            a.refine_step()
        else:
            if a.hi <= b.lo:
                return -1
            if b.hi <= a.lo:
                return 1
            a.refine_step()
            b.refine_step()


def compare(a, b):
    """Return -1, 0 or 1 for a < b, a == b, a > b (exact decision)."""
    g = P.gcd(a.factor, b.factor)
    if P.degree(g) >= 1:
        ja = _locate_in(a, g)
        jb = _locate_in(b, g)
        if ja is not None and jb is not None:
            if ja == jb:
                return 0
            return -1 if ja < jb else 1
    return _order(a, b)
