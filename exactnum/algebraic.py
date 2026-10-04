"""Exact real algebraic numbers via rational isolating intervals.

An :class:`AlgebraicNumber` is a rational polynomial together with a
rational interval that isolates exactly one real root (verified with
Sturm's theorem, so multiple roots in the input polynomial are handled by
square-free reduction).  floor, ceil, round-half-to-even and comparison
are decided exactly: intervals are refined by bisection until they no
longer straddle the decision boundary, and rational boundary hits are
detected by exact sign evaluation.  A refinement budget may be imposed;
exhausting it raises :class:`RefinementBudgetExhausted` instead of
returning an approximate answer.

Refined intervals are cached in an :class:`EvidenceCache`, which can be
saved to / restored from a JSON checkpoint.  Every cached entry is
re-validated (sign change, containment, exact root for point intervals)
before it is trusted, so tampered evidence is rejected.
"""

from __future__ import annotations

import json
from fractions import Fraction

from . import polys
from .introot import integer_kth_root


class RefinementBudgetExhausted(Exception):
    """Raised when the refinement budget runs out before a decision."""


class EvidenceError(Exception):
    """Raised when cached or checkpointed evidence fails validation."""


class _Budget:
    def __init__(self, limit):
        self.limit = limit  # None means unlimited

    def consume(self):
        if self.limit is not None:
            if self.limit <= 0:
                raise RefinementBudgetExhausted(
                    "refinement budget exhausted before a decision was reached"
                )
            self.limit -= 1


def _to_frac(v):
    if isinstance(v, Fraction):
        return v
    if isinstance(v, bool):
        raise TypeError("boolean is not a rational")
    if isinstance(v, int):
        return Fraction(v)
    if isinstance(v, str):
        return Fraction(v)
    raise TypeError(f"not a rational: {v!r}")


def _validate_cached_interval(poly, initial_lo, initial_hi, lo, hi):
    """Check that [lo, hi] is trustworthy evidence for poly's unique root.

    The cached interval must lie inside the originally validated isolating
    interval and must itself exhibit a strict sign change (or, for a point
    interval, vanish exactly).
    """
    if not (initial_lo <= lo <= hi <= initial_hi):
        raise EvidenceError("cached interval escapes its isolating interval")
    if lo == hi:
        if polys.sign_at(poly, lo) != 0:
            raise EvidenceError("cached point interval is not an exact root")
    else:
        s_lo = polys.sign_at(poly, lo)
        s_hi = polys.sign_at(poly, hi)
        if s_lo == 0 or s_hi == 0 or s_lo == s_hi:
            raise EvidenceError("cached interval has no sign change")


class EvidenceCache:
    """JSON-serializable store of refined isolating intervals."""

    VERSION = 1

    def __init__(self):
        self.intervals = {}

    @staticmethod
    def make_key(poly, lo, hi):
        return json.dumps(
            {
                "poly": [str(c) for c in poly],
                "interval": [str(lo), str(hi)],
            },
            sort_keys=True,
        )

    def get(self, key):
        entry = self.intervals.get(key)
        if entry is None:
            return None
        return Fraction(entry[0]), Fraction(entry[1])

    def store(self, key, lo, hi):
        self.intervals[key] = [str(lo), str(hi)]

    def save(self, path):
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(
                {"version": self.VERSION, "intervals": self.intervals},
                fh,
                indent=2,
                sort_keys=True,
            )

    @classmethod
    def load(cls, path):
        """Load a checkpoint, fully re-validating every entry.

        Raises :class:`EvidenceError` if any entry is malformed, escapes
        its original isolating interval, or fails the sign-change check.
        """
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, dict) or data.get("version") != cls.VERSION:
            raise EvidenceError("unsupported checkpoint format")
        raw = data.get("intervals")
        if not isinstance(raw, dict):
            raise EvidenceError("checkpoint is missing interval evidence")
        cache = cls()
        for key, entry in raw.items():
            try:
                parsed = json.loads(key)
                poly = polys.monic(
                    polys.squarefree_part(polys.to_fractions(parsed["poly"]))
                )
                init_lo, init_hi = (_to_frac(v) for v in parsed["interval"])
                lo, hi = (_to_frac(v) for v in entry)
            except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
                raise EvidenceError(f"malformed checkpoint entry: {exc}") from exc
            _validate_cached_interval(poly, init_lo, init_hi, lo, hi)
            cache.intervals[key] = [str(lo), str(hi)]
        return cache


class AlgebraicNumber:
    """A real algebraic number: polynomial + verified isolating interval."""

    def __init__(self, coeffs, lo, hi, *, cache=None):
        p = polys.to_fractions(coeffs)
        if polys.is_zero(p):
            raise ValueError("zero polynomial has no isolated root")
        lo = _to_frac(lo)
        hi = _to_frac(hi)
        if lo > hi:
            raise ValueError("empty interval")
        self._poly = polys.monic(polys.squarefree_part(p))
        if lo == hi:
            if polys.sign_at(self._poly, lo) != 0:
                raise ValueError("point interval must be an exact root")
            self._lo = self._hi = lo
            self._point = True
        else:
            s_lo = polys.sign_at(self._poly, lo)
            s_hi = polys.sign_at(self._poly, hi)
            if s_lo == 0:
                self._lo = self._hi = lo
                self._point = True
            elif s_hi == 0:
                self._lo = self._hi = hi
                self._point = True
            else:
                if s_lo == s_hi:
                    raise ValueError("interval endpoints have no sign change")
                if polys.sturm_count(self._poly, lo, hi) != 1:
                    raise ValueError(
                        "interval does not isolate exactly one real root"
                    )
                self._lo, self._hi = lo, hi
                self._point = False
        self._initial = (self._lo, self._hi)
        self._cache = cache
        self._key = EvidenceCache.make_key(self._poly, self._lo, self._hi)
        if cache is not None:
            cached = cache.get(self._key)
            if cached is not None:
                clo, chi = cached
                _validate_cached_interval(
                    self._poly, self._initial[0], self._initial[1], clo, chi
                )
                self._lo, self._hi = clo, chi
                self._point = clo == chi
            self._store_cache()

    # -- constructors ---------------------------------------------------

    @classmethod
    def from_rational(cls, q, *, cache=None):
        q = _to_frac(q)
        return cls([-q, Fraction(1)], q, q, cache=cache)

    @classmethod
    def from_decimal(cls, text, *, cache=None):
        """Build from an exact decimal string such as "-3.14"."""
        return cls.from_rational(Fraction(text), cache=cache)

    @classmethod
    def kth_root(cls, n, k, *, cache=None):
        """The real k-th root of integer n (odd k allows n < 0)."""
        ev = integer_kth_root(n, k)
        if ev.r_pow_k == n:
            return cls.from_rational(Fraction(ev.r), cache=cache)
        coeffs = [Fraction(0)] * (k + 1)
        coeffs[0] = Fraction(-n)
        coeffs[k] = Fraction(1)
        return cls(coeffs, Fraction(ev.r), Fraction(ev.r + 1), cache=cache)

    # -- introspection --------------------------------------------------

    @property
    def polynomial(self):
        return list(self._poly)

    @property
    def interval(self):
        return self._lo, self._hi

    @property
    def is_exact_rational(self):
        return self._point

    def __repr__(self):
        return f"AlgebraicNumber({self._poly!r}, {self._lo}, {self._hi})"

    # -- refinement -----------------------------------------------------

    def _store_cache(self):
        if self._cache is not None:
            self._cache.store(self._key, self._lo, self._hi)

    def _refine(self, budget):
        if self._point:
            return
        budget.consume()
        mid = (self._lo + self._hi) / 2
        s = polys.sign_at(self._poly, mid)
        if s == 0:
            self._lo = self._hi = mid
            self._point = True
        elif s == polys.sign_at(self._poly, self._lo):
            self._lo = mid
        else:
            self._hi = mid
        self._store_cache()

    # -- exact comparisons ----------------------------------------------

    def compare_rational(self, c):
        """Exact sign of (self - c) for rational c: -1, 0 or 1."""
        c = _to_frac(c)
        if self._point:
            return (self._lo > c) - (self._lo < c)
        if c <= self._lo:
            return 1
        if c >= self._hi:
            return -1
        s_c = polys.sign_at(self._poly, c)
        if s_c == 0:
            return 0
        # The square-free polynomial has constant sign on (root, hi).
        s_hi = polys.sign_at(self._poly, self._hi)
        return -1 if s_c == s_hi else 1

    def compare(self, other, budget=None):
        """Exact three-way comparison of two algebraic numbers."""
        if not isinstance(other, AlgebraicNumber):
            other = AlgebraicNumber.from_rational(other)
        b = _Budget(budget)
        a, c = self, other
        while True:
            if a._point and c._point:
                return (a._lo > c._lo) - (a._lo < c._lo)
            if a._point:
                return -c.compare_rational(a._lo)
            if c._point:
                return a.compare_rational(c._lo)
            if a._hi <= c._lo:
                return -1
            if c._hi <= a._lo:
                return 1
            g = polys.gcd_poly(a._poly, c._poly)
            if polys.degree(g) >= 1:
                ga = polys.sturm_count(g, a._lo, a._hi)
                gb = polys.sturm_count(g, c._lo, c._hi)
                if ga >= 1 and gb >= 1:
                    nested = (c._lo <= a._lo and a._hi <= c._hi) or (
                        a._lo <= c._lo and c._hi <= a._hi
                    )
                    if nested:
                        return 0
            if a._hi - a._lo >= c._hi - c._lo:
                a._refine(b)
            else:
                c._refine(b)

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

    # -- exact rounding ---------------------------------------------------

    def _floor(self, budget):
        while True:
            if self._point:
                return self._lo.numerator // self._lo.denominator
            m = self._lo.numerator // self._lo.denominator
            if self._hi <= m + 1:
                return m
            self._refine(budget)

    def floor(self, budget=None):
        """Largest integer <= self."""
        return self._floor(_Budget(budget))

    def neg(self):
        """The exact negation -self."""
        coeffs = [
            c if i % 2 == 0 else -c for i, c in enumerate(self._poly)
        ]
        return AlgebraicNumber(coeffs, -self._hi, -self._lo, cache=self._cache)

    def ceil(self, budget=None):
        """Smallest integer >= self."""
        return -self.neg()._floor(_Budget(budget))

    def round_half_even(self, budget=None):
        """Nearest integer; exact halves round to the even neighbour."""
        b = _Budget(budget)
        m = self._floor(b)
        half = Fraction(2 * m + 1, 2)
        cmp = self.compare_rational(half)
        if cmp < 0:
            return m
        if cmp > 0:
            return m + 1
        return m if m % 2 == 0 else m + 1

    round_even = round_half_even

    # -- scaling ----------------------------------------------------------

    def scale(self, factor):
        """Exact multiple by a rational factor, as a new AlgebraicNumber."""
        p = _to_frac(factor)
        if p == 0:
            return AlgebraicNumber.from_rational(0)
        a, b = p.numerator, p.denominator
        d = polys.degree(self._poly)
        q = [
            self._poly[i] * Fraction(a) ** (d - i) * Fraction(b) ** i
            for i in range(d + 1)
        ]
        if p > 0:
            lo, hi = self._lo * p, self._hi * p
        else:
            lo, hi = self._hi * p, self._lo * p
        return AlgebraicNumber(q, lo, hi, cache=self._cache)
