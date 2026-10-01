"""Algebraic numbers represented by rational isolating intervals.

Every decision (floor, ceil, round-half-even, comparison) is exact:
whenever an interval straddles an integer or half-integer boundary, the
answer is settled either by further bisection refinement or by exact sign
evaluation of the defining polynomial at the boundary rational.  A
``budget`` only limits how many bisection steps are attempted before
falling back to exact sign determination -- a depleted budget never
causes an approximate decision.
"""
from __future__ import annotations

import json
from fractions import Fraction

from .polys import (
    frac_ceil,
    frac_floor,
    gcd_poly,
    isolate_real_roots,
    round_half_even_fraction,
    sign_at_fraction,
    squarefree_part,
    sturm_count,
)


class AlgebraicError(ValueError):
    """Raised when an algebraic number specification is invalid."""


def _cmp(a, b):
    return (a > b) - (a < b)


class AlgebraicNumber:
    """A real algebraic number: squarefree polynomial + isolating interval.

    The interval ``(lo, hi)`` is rational and contains exactly one real
    root of ``p`` (verified with Sturm's theorem at construction, so
    forged specifications are rejected immediately).  A number discovered
    to be rational is stored exactly.
    """

    def __init__(self, coeffs, lo=None, hi=None, *, exact=None, cache=None):
        self.p = squarefree_part(coeffs)
        if len(self.p) < 2:
            raise AlgebraicError("constant polynomial has no root to isolate")
        self._cache = cache
        if exact is not None:
            exact = Fraction(exact)
            if sign_at_fraction(self.p, exact) != 0:
                raise AlgebraicError(f"{exact} is not a root of the polynomial")
            self.exact = exact
            self.lo = self.hi = None
            self.sign_lo = 0
            self._iso = ("exact", str(exact))
        else:
            lo = Fraction(lo)
            hi = Fraction(hi)
            if not lo < hi:
                raise AlgebraicError("isolating interval must satisfy lo < hi")
            s_lo = sign_at_fraction(self.p, lo)
            s_hi = sign_at_fraction(self.p, hi)
            if s_lo == 0 or s_hi == 0:
                raise AlgebraicError("interval endpoint is a root; use exact=")
            if sturm_count(self.p, lo, hi) != 1:
                raise AlgebraicError(
                    "interval does not isolate exactly one real root"
                )
            self.exact = None
            self.lo, self.hi = lo, hi
            self.sign_lo = s_lo
            self._iso = (str(lo), str(hi))

    # ------------------------------------------------------------------
    # constructors
    # ------------------------------------------------------------------
    @classmethod
    def from_rational(cls, value, cache=None):
        f = Fraction(value)
        return cls([-f.numerator, f.denominator], exact=f, cache=cache)

    @classmethod
    def all_real_roots(cls, coeffs, cache=None):
        """All real roots of ``coeffs`` as AlgebraicNumber instances."""
        roots = []
        for item in isolate_real_roots(coeffs):
            if item[0] == "exact":
                roots.append(cls(coeffs, exact=item[1], cache=cache))
            else:
                roots.append(cls(coeffs, item[1], item[2], cache=cache))
        return roots

    # ------------------------------------------------------------------
    # cache integration
    # ------------------------------------------------------------------
    def cache_key(self):
        return json.dumps([list(self.p), list(self._iso)])

    def iso_json(self):
        if self._iso[0] == "exact":
            return {"exact": self._iso[1]}
        return {"lo": self._iso[0], "hi": self._iso[1]}

    def state_json(self):
        if self.exact is not None:
            return {"exact": str(self.exact)}
        return {"lo": str(self.lo), "hi": str(self.hi)}

    def _cache_get(self, op):
        if self._cache is None:
            return None
        return self._cache.lookup(self.cache_key(), op)

    def _cache_put(self, op, value):
        if self._cache is not None:
            self._certify(op, value)
            self._cache.record(self, op, value)

    def _certify(self, op, value):
        """Refine until the isolating interval itself proves ``op == value``.

        This makes every cached result self-certifying: a checkpoint can be
        re-verified later from the interval alone.  Terminates because the
        stored value is the exact result, so the root lies strictly inside
        the required open bounds.
        """
        v = Fraction(value)
        half = Fraction(1, 2)
        while self.exact is None:
            if op == "floor" and self.lo >= v and self.hi <= v + 1:
                return
            if op == "ceil" and self.lo >= v - 1 and self.hi <= v:
                return
            if op == "round" and self.lo >= v - half and self.hi <= v + half:
                return
            self.refine()

    # ------------------------------------------------------------------
    # exact sign machinery
    # ------------------------------------------------------------------
    def compare_to_rational(self, q):
        """Exact comparison of this number against rational ``q``.

        Returns 1, 0 or -1.  Never approximate: uses exact polynomial sign
        evaluation at ``q`` when ``q`` lies inside the isolating interval.
        """
        q = Fraction(q)
        if self.exact is not None:
            return _cmp(self.exact, q)
        if q <= self.lo:
            return 1
        if q >= self.hi:
            return -1
        s = sign_at_fraction(self.p, q)
        if s == 0:
            # q is the unique root inside the interval: the number is
            # exactly rational from now on.
            self.exact = q
            self.lo = self.hi = None
            return 0
        return 1 if s == self.sign_lo else -1

    def refine(self, steps=1):
        """Bisect the isolating interval ``steps`` times (exact)."""
        for _ in range(steps):
            if self.exact is not None:
                return
            mid = (self.lo + self.hi) / 2
            c = self.compare_to_rational(mid)
            if self.exact is not None:
                return
            if c > 0:
                self.lo = mid
            else:
                self.hi = mid

    # ------------------------------------------------------------------
    # rounding
    # ------------------------------------------------------------------
    def floor(self, budget=None):
        """Exact floor.  ``budget`` bounds bisection attempts only; the
        result is always settled by exact sign determination."""
        cached = self._cache_get("floor")
        if cached is not None:
            return cached
        if budget:
            self.refine(budget)
        if self.exact is not None:
            value = frac_floor(self.exact)
        else:
            lo_m = frac_floor(self.lo)
            hi_m = frac_floor(self.hi)
            if self.hi.denominator == 1:
                hi_m -= 1  # root < hi, and hi is an integer
            while lo_m < hi_m:
                mid = (lo_m + hi_m + 1) // 2
                c = self.compare_to_rational(mid)
                if c == 0:
                    lo_m = mid
                    break
                if c > 0:
                    lo_m = mid
                else:
                    hi_m = mid - 1
            value = lo_m
        self._cache_put("floor", value)
        return value

    def ceil(self, budget=None):
        """Exact ceiling (see ``floor`` for the budget semantics)."""
        cached = self._cache_get("ceil")
        if cached is not None:
            return cached
        if budget:
            self.refine(budget)
        if self.exact is not None:
            value = frac_ceil(self.exact)
        else:
            lo_m = frac_ceil(self.lo)
            if self.lo.denominator == 1:
                lo_m += 1  # root > lo, and lo is an integer
            hi_m = frac_ceil(self.hi)
            while lo_m < hi_m:
                mid = (lo_m + hi_m) // 2
                c = self.compare_to_rational(mid)
                if c == 0:
                    lo_m = mid
                    break
                if c < 0:
                    hi_m = mid
                else:
                    lo_m = mid + 1
            value = lo_m
        self._cache_put("ceil", value)
        return value

    def round_half_even(self, budget=None):
        """Round to nearest integer, ties to even -- always exact.

        When the interval straddles a half-integer, the tie is resolved by
        exact sign evaluation at that half-integer, never by approximation.
        """
        cached = self._cache_get("round")
        if cached is not None:
            return cached
        if budget:
            self.refine(budget)
        if self.exact is not None:
            value = round_half_even_fraction(self.exact)
        else:
            m = self.floor()
            if self.exact is not None:
                value = round_half_even_fraction(self.exact)
            else:
                c = self.compare_to_rational(Fraction(2 * m + 1, 2))
                if c < 0:
                    value = m
                elif c > 0:
                    value = m + 1
                else:  # exact tie x == m + 1/2: round to even
                    value = m if m % 2 == 0 else m + 1
        self._cache_put("round", value)
        return value

    # ------------------------------------------------------------------
    # scaling and comparison
    # ------------------------------------------------------------------
    def scale(self, p, q):
        """Return the algebraic number ``(p/q) * self`` (exact)."""
        p = int(p)
        q = int(q)
        if q == 0:
            raise AlgebraicError("scale denominator must be non-zero")
        if q < 0:
            p, q = -p, -q
        if p == 0:
            return AlgebraicNumber.from_rational(0, cache=self._cache)
        if self.exact is not None:
            return AlgebraicNumber.from_rational(
                self.exact * Fraction(p, q), cache=self._cache
            )
        d = len(self.p) - 1
        # If sum a_i x^i = 0 and y = (p/q) x then sum a_i q^i p^(d-i) y^i = 0.
        new = [self.p[i] * q ** i * p ** (d - i) for i in range(d + 1)]
        factor = Fraction(p, q)
        lo, hi = self.lo * factor, self.hi * factor
        if factor < 0:
            lo, hi = hi, lo
        return AlgebraicNumber(new, lo, hi, cache=self._cache)

    def scaled_round(self, p, q, mode="half_even", budget=None):
        """Round ``(p/q) * self`` with mode floor/ceil/half_even."""
        s = self.scale(p, q)
        if mode == "half_even":
            return s.round_half_even(budget)
        if mode == "floor":
            return s.floor(budget)
        if mode == "ceil":
            return s.ceil(budget)
        raise AlgebraicError(f"unknown rounding mode: {mode}")

    def compare(self, other, budget=None):
        """Exact comparison of two algebraic numbers: -1, 0 or 1.

        Equality across different polynomial representations is detected
        through the polynomial gcd plus Sturm root counting; otherwise the
        isolating intervals are refined until they are disjoint.
        """
        if self.exact is not None and other.exact is not None:
            return _cmp(self.exact, other.exact)
        if self.exact is not None:
            return -other.compare_to_rational(self.exact)
        if other.exact is not None:
            return self.compare_to_rational(other.exact)
        g = gcd_poly(self.p, other.p)
        if len(g) > 1:
            if (
                sturm_count(g, self.lo, self.hi) == 1
                and sturm_count(g, other.lo, other.hi) == 1
            ):
                return 0
        if budget:
            self.refine(budget)
            other.refine(budget)
        while True:
            if self.hi <= other.lo:
                return -1
            if other.hi <= self.lo:
                return 1
            self.refine()
            other.refine()

    def sign(self):
        return self.compare_to_rational(0)

    # ------------------------------------------------------------------
    # dunders
    # ------------------------------------------------------------------
    def __eq__(self, other):
        if not isinstance(other, AlgebraicNumber):
            return NotImplemented
        return self.compare(other) == 0

    def __lt__(self, other):
        return self.compare(other) < 0

    def __le__(self, other):
        return self.compare(other) <= 0

    def __gt__(self, other):
        return self.compare(other) > 0

    def __ge__(self, other):
        return self.compare(other) >= 0

    __hash__ = None

    def __repr__(self):
        return f"AlgebraicNumber({self.p}, {self.state_json()})"
