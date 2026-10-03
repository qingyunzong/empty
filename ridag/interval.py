"""Exact rational interval arithmetic with open/closed and infinite endpoints.

Endpoints are extended rationals: Fraction values or signed infinity.
An ``Interval`` is always non-empty; the empty set is represented by an
``IntervalUnion`` with no components.  ``IntervalUnion`` keeps a canonical
form: sorted, disjoint, non-mergeable components, so a union like
``(-inf,0) | (0,+inf)`` is never collapsed into the whole real line.
"""

from __future__ import annotations

from fractions import Fraction

__all__ = ["End", "Interval", "IntervalUnion", "NEG_INF", "POS_INF", "ZERO", "REALS"]


class End:
    """Extended-rational endpoint: a Fraction or signed infinity."""

    __slots__ = ("_v", "_inf")

    def __init__(self, value=None, inf=0):
        # inf in {-1, 0, +1}; when inf != 0, value is ignored.
        if inf:
            object.__setattr__(self, "_v", None)
            object.__setattr__(self, "_inf", 1 if inf > 0 else -1)
        else:
            v = value if isinstance(value, Fraction) else Fraction(value)
            object.__setattr__(self, "_v", v)
            object.__setattr__(self, "_inf", 0)

    def __setattr__(self, k, v):
        raise AttributeError("End is immutable")

    @staticmethod
    def fin(v):
        return End(v)

    @staticmethod
    def inf(sign):
        return End(None, sign)

    @property
    def is_inf(self):
        return self._inf != 0

    @property
    def inf_sign(self):
        return self._inf

    @property
    def val(self):
        if self._inf:
            raise ValueError("infinite endpoint has no rational value")
        return self._v

    def is_zero(self):
        return self._inf == 0 and self._v == 0

    def sign(self):
        if self._inf:
            return self._inf
        return (self._v > 0) - (self._v < 0)

    # -- ordering -----------------------------------------------------
    def _key(self):
        if self._inf:
            return (self._inf, Fraction(0))
        return (0, self._v)

    def __lt__(self, o):
        return self._key() < o._key()

    def __le__(self, o):
        return self._key() <= o._key()

    def __gt__(self, o):
        return self._key() > o._key()

    def __ge__(self, o):
        return self._key() >= o._key()

    def __eq__(self, o):
        return isinstance(o, End) and self._inf == o._inf and self._v == o._v

    def __hash__(self):
        return hash((self._inf, self._v))

    # -- arithmetic ---------------------------------------------------
    def __neg__(self):
        if self._inf:
            return End.inf(-self._inf)
        return End(-self._v)

    def __add__(self, o):
        if self._inf or o._inf:
            s = self._inf or o._inf
            if self._inf and o._inf and self._inf != o._inf:
                raise ArithmeticError("inf + -inf")
            return End.inf(s)
        return End(self._v + o._v)

    def __sub__(self, o):
        return self + (-o)

    def __mul__(self, o):
        if self._inf or o._inf:
            s = self.sign() * o.sign()
            if s == 0:
                raise ArithmeticError("0 * inf")
            return End.inf(s)
        return End(self._v * o._v)

    def __truediv__(self, o):
        # Only defined for finite, non-zero divisor.
        if o._inf or o._v == 0:
            raise ArithmeticError("unsupported division of endpoint")
        if self._inf:
            return End.inf(self._inf * (1 if o._v > 0 else -1))
        return End(self._v / o._v)

    def __repr__(self):
        if self._inf:
            return "-inf" if self._inf < 0 else "+inf"
        return str(self._v)


NEG_INF = End.inf(-1)
POS_INF = End.inf(1)
ZERO = End(0)


class Interval:
    """A single non-empty connected interval with exact endpoints."""

    __slots__ = ("lo", "lo_open", "hi", "hi_open")

    def __init__(self, lo, lo_open, hi, hi_open):
        lo = lo if isinstance(lo, End) else End(lo)
        hi = hi if isinstance(hi, End) else End(hi)
        if lo.is_inf and lo.inf_sign > 0:
            raise ValueError("lower endpoint cannot be +inf")
        if hi.is_inf and hi.inf_sign < 0:
            raise ValueError("upper endpoint cannot be -inf")
        if lo.is_inf:
            lo_open = True
        if hi.is_inf:
            hi_open = True
        if lo > hi or (lo == hi and (lo_open or hi_open)):
            raise ValueError("empty interval %r .. %r" % (lo, hi))
        self.lo, self.lo_open, self.hi, self.hi_open = lo, lo_open, hi, hi_open

    # -- constructors ---------------------------------------------------
    @staticmethod
    def point(v):
        e = v if isinstance(v, End) else End(v)
        return Interval(e, False, e, False)

    @staticmethod
    def closed(lo, hi):
        return Interval(lo, False, hi, False)

    @staticmethod
    def of(lo, lo_open, hi, hi_open):
        """Like the constructor but returns None instead of raising on empty."""
        try:
            return Interval(lo, lo_open, hi, hi_open)
        except ValueError:
            return None

    # -- predicates -----------------------------------------------------
    def is_point(self):
        return self.lo == self.hi

    def contains_end(self, e):
        if e < self.lo or e > self.hi:
            return False
        if e == self.lo and self.lo_open:
            return False
        if e == self.hi and self.hi_open:
            return False
        return True

    def contains_zero(self):
        return self.contains_end(ZERO)

    def strictly_positive(self):
        return self.lo.sign() > 0 or (self.lo.is_zero() and self.lo_open)

    def strictly_negative(self):
        return self.hi.sign() < 0 or (self.hi.is_zero() and self.hi_open)

    def excludes_zero(self):
        return self.strictly_positive() or self.strictly_negative()

    def is_bounded(self):
        return not (self.lo.is_inf or self.hi.is_inf)

    def width(self):
        if not self.is_bounded():
            return None
        return self.hi.val - self.lo.val

    def midpoint(self):
        if not self.is_bounded():
            raise ValueError("unbounded interval has no midpoint")
        return (self.lo.val + self.hi.val) / 2

    def __eq__(self, o):
        return (
            isinstance(o, Interval)
            and (self.lo, self.lo_open, self.hi, self.hi_open)
            == (o.lo, o.lo_open, o.hi, o.hi_open)
        )

    def __hash__(self):
        return hash((self.lo, self.lo_open, self.hi, self.hi_open))

    def __repr__(self):
        return "%s%s,%s%s" % (
            "(" if self.lo_open else "[",
            self.lo,
            self.hi,
            ")" if self.hi_open else "]",
        )

    # -- set operations ---------------------------------------------------
    def intersect(self, o):
        if self.lo > o.lo:
            lo, lo_open = self.lo, self.lo_open
        elif self.lo < o.lo:
            lo, lo_open = o.lo, o.lo_open
        else:
            lo, lo_open = self.lo, self.lo_open or o.lo_open
        if self.hi < o.hi:
            hi, hi_open = self.hi, self.hi_open
        elif self.hi > o.hi:
            hi, hi_open = o.hi, o.hi_open
        else:
            hi, hi_open = self.hi, self.hi_open or o.hi_open
        return Interval.of(lo, lo_open, hi, hi_open)

    def touches(self, o):
        """True if the two intervals can be merged into one connected piece."""
        if self.hi < o.lo or o.hi < self.lo:
            return False
        if self.hi == o.lo and self.hi_open and o.lo_open:
            return False
        if o.hi == self.lo and o.hi_open and self.lo_open:
            return False
        return True

    def merge(self, o):
        if self.lo < o.lo:
            lo, lo_open = self.lo, self.lo_open
        elif self.lo > o.lo:
            lo, lo_open = o.lo, o.lo_open
        else:
            lo, lo_open = self.lo, self.lo_open and o.lo_open
        if self.hi > o.hi:
            hi, hi_open = self.hi, self.hi_open
        elif self.hi < o.hi:
            hi, hi_open = o.hi, o.hi_open
        else:
            hi, hi_open = self.hi, self.hi_open and o.hi_open
        return Interval(lo, lo_open, hi, hi_open)

    def subset_of(self, o):
        if self.lo < o.lo or self.hi > o.hi:
            return False
        if self.lo == o.lo and (not self.lo_open) and o.lo_open:
            return False
        if self.hi == o.hi and (not self.hi_open) and o.hi_open:
            return False
        return True

    # -- arithmetic ---------------------------------------------------
    def __neg__(self):
        return Interval(-self.hi, self.hi_open, -self.lo, self.lo_open)

    def __add__(self, o):
        return Interval(
            self.lo + o.lo,
            self.lo_open or o.lo_open,
            self.hi + o.hi,
            self.hi_open or o.hi_open,
        )

    def __sub__(self, o):
        return self + (-o)

    def _sign_pieces(self):
        """Split into (negative, zero-point, positive) constant-sign parts."""
        neg = self.intersect(Interval(NEG_INF, True, ZERO, True))
        zer = Interval.point(ZERO) if self.contains_zero() else None
        pos = self.intersect(Interval(ZERO, True, POS_INF, True))
        return [p for p in (neg, zer, pos) if p is not None]

    def _mul_constsign(self, o):
        """Multiply two constant-sign intervals via corner extrema."""
        # {0} times anything is exactly {0} (closed), regardless of the
        # other factor's openness.
        for z in (self, o):
            if z.is_point() and z.lo.is_zero():
                return Interval.point(ZERO)
        corners = []
        for a, ao in ((self.lo, self.lo_open), (self.hi, self.hi_open)):
            for b, bo in ((o.lo, o.lo_open), (o.hi, o.hi_open)):
                if a.is_inf and b.is_zero():
                    # 0*inf: the product 0 is attained iff the zero side is
                    corners.append((ZERO, bo))
                elif b.is_inf and a.is_zero():
                    corners.append((ZERO, ao))
                else:
                    corners.append((a * b, ao or bo))
        lo = min(c for c, _ in corners)
        hi = max(c for c, _ in corners)
        lo_open = all(op for c, op in corners if c == lo)
        hi_open = all(op for c, op in corners if c == hi)
        return Interval(lo, lo_open, hi, hi_open)

    def __mul__(self, o):
        parts = [
            a._mul_constsign(b)
            for a in self._sign_pieces()
            for b in o._sign_pieces()
        ]
        return IntervalUnion(parts).as_interval()

    def reciprocal(self):
        """1/x for an interval whose closure may touch 0; returns a union."""
        out = []
        neg = self.intersect(Interval(NEG_INF, True, ZERO, True))
        pos = self.intersect(Interval(ZERO, True, POS_INF, True))
        for p in (neg, pos):
            if p is None:
                continue
            # map endpoints through t -> 1/t; 0 maps to signed infinity
            if p.hi.is_zero():
                lo = NEG_INF
            elif p.hi.is_inf:
                lo = ZERO
            else:
                lo = End(1) / p.hi
            if p.lo.is_zero():
                hi = POS_INF
            elif p.lo.is_inf:
                hi = ZERO
            else:
                hi = End(1) / p.lo
            out.append(Interval(lo, p.hi_open or p.hi.is_inf,
                                hi, p.lo_open or p.lo.is_inf))
        return IntervalUnion(out)

    def __truediv__(self, o):
        parts = []
        for r in o.reciprocal().intervals:
            prod = self * r
            if isinstance(prod, IntervalUnion):
                parts.extend(prod.intervals)
            elif prod is not None:
                parts.append(prod)
        return IntervalUnion(parts)

    def pow_int(self, n):
        """Exact integer power; negative n yields a union (pole at 0)."""
        if not isinstance(n, int):
            raise TypeError("exponent must be an integer")
        if n == 0:
            return IntervalUnion([Interval.point(1)])
        if n < 0:
            out = []
            for p in self.pow_int(-n).intervals:
                out.extend(p.reciprocal().intervals)
            return IntervalUnion(out)
        a, b = self.lo, self.hi
        if n % 2 == 1:
            lo = _pow_end(a, n)
            hi = _pow_end(b, n)
            return IntervalUnion([Interval(lo, self.lo_open, hi, self.hi_open)])
        # even power
        lo_e = ZERO if self.contains_zero() else min(_pow_end(a, n), _pow_end(b, n))
        lo_open = False
        if not self.contains_zero():
            cand = []
            if _pow_end(a, n) == lo_e:
                cand.append(self.lo_open)
            if _pow_end(b, n) == lo_e:
                cand.append(self.hi_open)
            lo_open = all(cand)
        hi_e = max(_pow_end(a, n), _pow_end(b, n))
        hi_open = True
        if not hi_e.is_inf:
            cand = []
            if _pow_end(a, n) == hi_e:
                cand.append(self.lo_open)
            if _pow_end(b, n) == hi_e:
                cand.append(self.hi_open)
            hi_open = all(cand)
        return IntervalUnion([Interval(lo_e, lo_open, hi_e, hi_open)])


def _pow_end(e, n):
    if e.is_inf:
        return End.inf(e.inf_sign if n % 2 else 1)
    return End(e.val ** n)


class IntervalUnion:
    """Canonical finite union of disjoint intervals."""

    __slots__ = ("intervals",)

    def __init__(self, parts=()):
        norm = []
        for p in sorted(parts, key=lambda i: (i.lo._key(), i.lo_open)):
            if norm and norm[-1].touches(p):
                norm[-1] = norm[-1].merge(p)
            else:
                norm.append(p)
        self.intervals = tuple(norm)

    def __eq__(self, o):
        return isinstance(o, IntervalUnion) and self.intervals == o.intervals

    def __hash__(self):
        return hash(self.intervals)

    def __repr__(self):
        return " | ".join(repr(i) for i in self.intervals) or "(empty)"

    def __iter__(self):
        return iter(self.intervals)

    def __len__(self):
        return len(self.intervals)

    def is_empty(self):
        return not self.intervals

    def as_interval(self):
        """Return the single component, or None if empty / disconnected."""
        if len(self.intervals) == 1:
            return self.intervals[0]
        return None

    def union(self, o):
        return IntervalUnion(self.intervals + o.intervals)

    def intersect(self, o):
        out = []
        for a in self.intervals:
            for b in o.intervals:
                r = a.intersect(b)
                if r is not None:
                    out.append(r)
        return IntervalUnion(out)

    def contains_end(self, e):
        return any(i.contains_end(e) for i in self.intervals)

    def contains_zero(self):
        return self.contains_end(ZERO)

    def excludes_zero(self):
        return not self.contains_zero()

    def covers(self, other):
        """True if ``other`` is a subset of self (component-wise)."""
        return all(
            any(p.subset_of(q) for q in self.intervals) for p in other.intervals
        )

    # -- lifted arithmetic --------------------------------------------
    def _binop(self, o, f):
        out = []
        for a in self.intervals:
            for b in o.intervals:
                r = f(a, b)
                if isinstance(r, IntervalUnion):
                    out.extend(r.intervals)
                else:
                    out.append(r)
        return IntervalUnion(out)

    def __add__(self, o):
        return self._binop(o, lambda a, b: a + b)

    def __sub__(self, o):
        return self._binop(o, lambda a, b: a - b)

    def __mul__(self, o):
        return self._binop(o, lambda a, b: a * b)

    def __truediv__(self, o):
        return self._binop(o, lambda a, b: a / b)

    def __neg__(self):
        return IntervalUnion([-i for i in self.intervals])

    def pow_int(self, n):
        out = []
        for i in self.intervals:
            out.extend(i.pow_int(n).intervals)
        return IntervalUnion(out)


REALS = IntervalUnion([Interval(NEG_INF, True, POS_INF, True)])
