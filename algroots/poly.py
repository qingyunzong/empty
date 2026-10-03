"""Exact arithmetic on univariate polynomials with rational coefficients.

Polynomials are stored as tuples of ``fractions.Fraction`` coefficients in
ascending order of degree, with no trailing zeros.  The zero polynomial is
the empty tuple.  All arithmetic is exact; no floating point is ever used.
"""
from __future__ import annotations

from fractions import Fraction


def parse_rational(value):
    """Parse a JSON-friendly rational (int, ``"p/q"`` string, Fraction)."""
    if isinstance(value, Fraction):
        return value
    if isinstance(value, bool):
        raise TypeError("not a rational: %r" % (value,))
    if isinstance(value, int):
        return Fraction(value)
    if isinstance(value, str):
        return Fraction(value.strip())
    raise TypeError("cannot parse rational from %r" % (value,))


class Poly:
    """Univariate polynomial with rational coefficients (exact)."""

    __slots__ = ("coeffs",)

    def __init__(self, coeffs=()):
        cs = [c if isinstance(c, Fraction) else parse_rational(c) for c in coeffs]
        last = len(cs) - 1
        while last >= 0 and cs[last] == 0:
            last -= 1
        self.coeffs = tuple(cs[: last + 1])

    # ------------------------------------------------------------------
    # basics
    @property
    def degree(self):
        """Degree of the polynomial; the zero polynomial has degree -1."""
        return len(self.coeffs) - 1

    @property
    def is_zero(self):
        return not self.coeffs

    @property
    def is_constant(self):
        return len(self.coeffs) <= 1

    def is_one(self):
        return self.coeffs == (Fraction(1),)

    @property
    def lc(self):
        """Leading coefficient."""
        if self.is_zero:
            raise ValueError("zero polynomial has no leading coefficient")
        return self.coeffs[-1]

    def __eq__(self, other):
        return isinstance(other, Poly) and self.coeffs == other.coeffs

    def __ne__(self, other):
        return not self.__eq__(other)

    def __hash__(self):
        return hash(self.coeffs)

    def __repr__(self):
        return "Poly(%s)" % (list(self.coeffs),)

    # ------------------------------------------------------------------
    # arithmetic
    def __neg__(self):
        return Poly([-c for c in self.coeffs])

    def __add__(self, other):
        other = _coerce(other)
        n = max(len(self.coeffs), len(other.coeffs))
        cs = []
        for i in range(n):
            a = self.coeffs[i] if i < len(self.coeffs) else Fraction(0)
            b = other.coeffs[i] if i < len(other.coeffs) else Fraction(0)
            cs.append(a + b)
        return Poly(cs)

    __radd__ = __add__

    def __sub__(self, other):
        return self + (-_coerce(other))

    def __rsub__(self, other):
        return _coerce(other) + (-self)

    def __mul__(self, other):
        if isinstance(other, (int, Fraction)) and not isinstance(other, bool):
            return self.scale(parse_rational(other))
        other = _coerce(other)
        if self.is_zero or other.is_zero:
            return Poly()
        cs = [Fraction(0)] * (self.degree + other.degree + 1)
        for i, a in enumerate(self.coeffs):
            if a:
                for j, b in enumerate(other.coeffs):
                    if b:
                        cs[i + j] += a * b
        return Poly(cs)

    __rmul__ = __mul__

    def __pow__(self, n):
        if n < 0:
            raise ValueError("negative powers not supported")
        result = Poly([1])
        base = self
        while n:
            if n & 1:
                result = result * base
            base = base * base
            n >>= 1
        return result

    def scale(self, c):
        c = parse_rational(c)
        if c == 0:
            return Poly()
        return Poly([c * a for a in self.coeffs])

    def monic(self):
        if self.is_zero:
            raise ValueError("zero polynomial cannot be made monic")
        return self.scale(1 / self.lc)

    def divmod(self, other):
        other = _coerce(other)
        if other.is_zero:
            raise ZeroDivisionError("polynomial division by zero")
        if self.degree < other.degree:
            return Poly(), self
        rem = list(self.coeffs)
        quo = [Fraction(0)] * (self.degree - other.degree + 1)
        inv_lc = 1 / other.lc
        d = other.degree
        for k in range(self.degree - other.degree, -1, -1):
            c = rem[d + k] * inv_lc
            quo[k] = c
            if c:
                for j in range(d + 1):
                    rem[j + k] -= c * other.coeffs[j]
        return Poly(quo), Poly(rem)

    def __floordiv__(self, other):
        return self.divmod(other)[0]

    def __mod__(self, other):
        return self.divmod(other)[1]

    def gcd(self, other):
        """Monic greatest common divisor (exact Euclidean algorithm)."""
        a, b = self, _coerce(other)
        while not b.is_zero:
            a, b = b, a % b
        if a.is_zero:
            return a
        return a.monic()

    def derivative(self):
        if self.is_zero:
            return Poly()
        return Poly([i * self.coeffs[i] for i in range(1, len(self.coeffs))])

    def evaluate(self, x):
        """Exact Horner evaluation at a rational point."""
        x = parse_rational(x)
        acc = Fraction(0)
        for c in reversed(self.coeffs):
            acc = acc * x + c
        return acc

    def sign_at(self, x):
        v = self.evaluate(x)
        return (v > 0) - (v < 0)

    # ------------------------------------------------------------------
    # square-free factorization (Yun's algorithm, characteristic 0)
    def squarefree_part(self):
        """Product of the distinct irreducible factors (monic)."""
        if self.is_zero:
            raise ValueError("zero polynomial")
        f = self.monic()
        return f // f.gcd(f.derivative())

    def squarefree_factorization(self):
        """Return ``(content, [(factor, multiplicity), ...])`` such that

            self == content * prod(factor ** multiplicity)

        with each factor monic, nonconstant and square-free, factors
        pairwise coprime, and multiplicities strictly increasing.
        """
        if self.is_zero:
            raise ValueError("zero polynomial has no square-free factorization")
        content = self.lc
        f = self.monic()
        factors = []
        if f.is_one():
            return content, factors
        g = f.gcd(f.derivative())
        w = f // g
        i = 1
        while not w.is_one():
            y = w.gcd(g)
            z = w // y
            if not z.is_one():
                factors.append((z, i))
            w = y
            g = g // y
            i += 1
        if not g.is_one():  # cannot happen in characteristic 0
            raise ArithmeticError("square-free factorization failed")
        return content, factors

    # ------------------------------------------------------------------
    # serialization
    def to_json(self):
        return [str(c) for c in self.coeffs]

    @staticmethod
    def from_json(data):
        return Poly([parse_rational(c) for c in data])


def _coerce(value):
    if isinstance(value, Poly):
        return value
    return Poly([parse_rational(value)])
