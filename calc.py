"""Correctly-rounded decimal calculator.

Rational arithmetic (+, -, *, /) is carried out exactly with Fraction.
sqrt of a non-square rational is kept as a lazy exact real that can be
approximated to any number of digits on demand, so intermediate results
are never truncated. The final value is rounded once, correctly, to p
significant digits under the requested rounding mode.

CLI: python calc.py <expression> <precision> <mode>
Modes: HALF_EVEN | HALF_UP | DOWN | FLOOR
"""

import re
import sys
from fractions import Fraction
from math import isqrt

MODES = ("HALF_EVEN", "HALF_UP", "DOWN", "FLOOR")


class CalcError(Exception):
    pass


# --------------------------------------------------------------------------
# Exact / lazily-exact real numbers
# --------------------------------------------------------------------------

class Real:
    def approx(self, k):
        """Return a Fraction a with |a - value| <= 10**-k."""
        raise NotImplementedError


class Rat(Real):
    def __init__(self, frac):
        self.f = frac

    def approx(self, k):
        return self.f


class Add(Real):
    def __init__(self, a, b):
        self.a, self.b = a, b

    def approx(self, k):
        return self.a.approx(k + 1) + self.b.approx(k + 1)


class Neg(Real):
    def __init__(self, a):
        self.a = a

    def approx(self, k):
        return -self.a.approx(k)


class Mul(Real):
    def __init__(self, a, b):
        self.a, self.b = a, b

    def approx(self, k):
        ma = magnitude(self.a)
        mb = magnitude(self.b)
        s = len(str(ma + mb + 1)) + 1
        return self.a.approx(k + s) * self.b.approx(k + s)


class Div(Real):
    def __init__(self, a, b):
        self.a, self.b = a, b

    def approx(self, k):
        j = positive_lower_bound(self.b)  # |b| > 10**-j
        ma = magnitude(self.a)
        mb = magnitude(self.b)
        t = k + 2 * j + len(str(2 * (ma + mb)))
        return self.a.approx(t) / self.b.approx(t)


class Sqrt(Real):
    def __init__(self, x):
        self.x = x

    def approx(self, k):
        j = positive_lower_bound(self.x)  # x > 10**-j
        X = self.x.approx(k + 1 + j)
        m = k + 1
        scaled = X * 10 ** (2 * m)
        r = isqrt(scaled.numerator // scaled.denominator)
        return Fraction(r, 10 ** m)


def magnitude(x):
    """Integer upper bound of |x|."""
    if isinstance(x, Rat):
        f = abs(x.f)
    else:
        f = abs(x.approx(0))
    return f.numerator // f.denominator + 2


def positive_lower_bound(x):
    """Return j such that |x| > 10**-j (x assumed nonzero)."""
    j = 0
    while j < 1000:
        a = x.approx(j)
        bound = Fraction(1, 10 ** j)
        if abs(a) > 2 * bound:
            return j
        j += 1
    raise CalcError("value is zero or too close to zero")


# --------------------------------------------------------------------------
# Arithmetic constructors (keep rationals exact, simplify sqrt products)
# --------------------------------------------------------------------------

def ev_neg(a):
    if isinstance(a, Rat):
        return Rat(-a.f)
    return Neg(a)


def ev_add(a, b):
    if isinstance(a, Rat) and isinstance(b, Rat):
        return Rat(a.f + b.f)
    return Add(a, b)


def ev_sub(a, b):
    if isinstance(a, Rat) and isinstance(b, Rat):
        return Rat(a.f - b.f)
    return Add(a, ev_neg(b))


def ev_mul(a, b):
    if isinstance(a, Rat) and isinstance(b, Rat):
        return Rat(a.f * b.f)
    if isinstance(a, Sqrt) and isinstance(b, Sqrt) \
            and isinstance(a.x, Rat) and isinstance(b.x, Rat):
        return ev_sqrt(Rat(a.x.f * b.x.f))
    return Mul(a, b)


def ev_div(a, b):
    if isinstance(b, Rat) and b.f == 0:
        raise CalcError("division by zero")
    if isinstance(a, Rat) and isinstance(b, Rat):
        return Rat(a.f / b.f)
    if isinstance(a, Sqrt) and isinstance(b, Sqrt) \
            and isinstance(a.x, Rat) and isinstance(b.x, Rat):
        return ev_sqrt(Rat(a.x.f / b.x.f))
    return Div(a, b)


def ev_sqrt(x):
    if isinstance(x, Rat):
        f = x.f
        if f < 0:
            raise CalcError("sqrt of a negative number")
        n, d = f.numerator, f.denominator
        rn, rd = isqrt(n), isqrt(d)
        if rn * rn == n and rd * rd == d:
            return Rat(Fraction(rn, rd))
    return Sqrt(x)


# --------------------------------------------------------------------------
# Expression parser
# --------------------------------------------------------------------------

TOKEN_RE = re.compile(r"\s*(?:(\d+(?:\.\d*)?|\.\d+)|([A-Za-z_]\w*)|(.))")


def tokenize(text):
    tokens = []
    pos = 0
    while pos < len(text):
        if text[pos:].strip() == "":
            break
        m = TOKEN_RE.match(text, pos)
        if not m:
            raise CalcError("invalid expression")
        pos = m.end()
        num, ident, other = m.groups()
        if num is not None:
            tokens.append(("num", num))
        elif ident is not None:
            tokens.append(("id", ident))
        elif other in "+-*/()":
            tokens.append((other, other))
        else:
            raise CalcError(f"unexpected character {other!r}")
    return tokens


class Parser:
    def __init__(self, text):
        self.tokens = tokenize(text)
        self.pos = 0

    def peek(self):
        if self.pos < len(self.tokens):
            return self.tokens[self.pos][0]
        return None

    def advance(self):
        tok = self.tokens[self.pos]
        self.pos += 1
        return tok

    def parse_expr(self):
        v = self.parse_term()
        while self.peek() in ("+", "-"):
            op = self.advance()[0]
            rhs = self.parse_term()
            v = ev_add(v, rhs) if op == "+" else ev_sub(v, rhs)
        return v

    def parse_term(self):
        v = self.parse_factor()
        while self.peek() in ("*", "/"):
            op = self.advance()[0]
            rhs = self.parse_factor()
            v = ev_mul(v, rhs) if op == "*" else ev_div(v, rhs)
        return v

    def parse_factor(self):
        if self.peek() == "+":
            self.advance()
            return self.parse_factor()
        if self.peek() == "-":
            self.advance()
            return ev_neg(self.parse_factor())
        return self.parse_primary()

    def parse_primary(self):
        if self.pos >= len(self.tokens):
            raise CalcError("unexpected end of expression")
        kind, val = self.advance()
        if kind == "num":
            return Rat(Fraction(val))
        if kind == "(":
            v = self.parse_expr()
            if self.peek() != ")":
                raise CalcError("missing closing parenthesis")
            self.advance()
            return v
        if kind == "id":
            if val != "sqrt":
                raise CalcError(f"unknown function {val!r}")
            if self.peek() != "(":
                raise CalcError("expected ( after sqrt")
            self.advance()
            arg = self.parse_expr()
            if self.peek() != ")":
                raise CalcError("missing closing parenthesis")
            self.advance()
            return ev_sqrt(arg)
        raise CalcError(f"unexpected token {val!r}")


def evaluate(text):
    parser = Parser(text)
    value = parser.parse_expr()
    if parser.pos != len(parser.tokens):
        raise CalcError("trailing characters in expression")
    return value


# --------------------------------------------------------------------------
# Correct rounding to p significant digits
# --------------------------------------------------------------------------

def pow10(e):
    return Fraction(10) ** e if e >= 0 else Fraction(1, 10 ** (-e))


def floor_log10_fraction(fr):
    """e with 10**e <= fr < 10**(e+1), for fr > 0."""
    n, d = fr.numerator, fr.denominator
    e = len(str(n)) - len(str(d))
    while fr < pow10(e):
        e -= 1
    while fr >= pow10(e + 1):
        e += 1
    return e


def floor_log10_real(x):
    k = 4
    while k <= 4096:
        a = x.approx(k)
        eps = Fraction(1, 10 ** k)
        if a > 2 * eps:
            e = floor_log10_fraction(a)
            if a - eps >= pow10(e) and a + eps < pow10(e + 1):
                return e
        k *= 2
    raise CalcError("cannot determine magnitude of value")


def sign_of(x):
    if isinstance(x, Rat):
        return (x.f > 0) - (x.f < 0)
    j = 0
    while j < 1000:
        a = x.approx(j)
        bound = Fraction(1, 10 ** j)
        if a > bound:
            return 1
        if a < -bound:
            return -1
        j += 1
    raise CalcError("cannot determine sign of value")


def decide_up(q, rem, sign, mode):
    """Whether the magnitude rounds up, given discarded fraction rem in [0,1)."""
    if rem == 0:
        return False
    if mode == "DOWN":
        return False
    if mode == "FLOOR":
        return sign < 0
    twice = 2 * rem
    if mode == "HALF_UP":
        return twice >= 1
    if mode == "HALF_EVEN":
        if twice != 1:
            return twice > 1
        return q % 2 == 1
    raise CalcError(f"invalid rounding mode {mode!r}")


def format_decimal(sign, q, exp10):
    """Format sign * q * 10**exp10 as a plain decimal string."""
    if q == 0:
        return "0"
    digits = str(q)
    if exp10 >= 0:
        s = digits + "0" * exp10
    else:
        pos = len(digits) + exp10
        if pos > 0:
            s = digits[:pos] + "." + digits[pos:]
        else:
            s = "0." + "0" * (-pos) + digits
    return ("-" if sign < 0 else "") + s


def round_fraction(f, p, mode):
    """Correctly round an exact Fraction to p significant digits."""
    if f == 0:
        return "0"
    sign = -1 if f < 0 else 1
    a = abs(f)
    e = floor_log10_fraction(a)
    m = p - 1 - e
    if m >= 0:
        num, den = a.numerator * 10 ** m, a.denominator
    else:
        num, den = a.numerator, a.denominator * 10 ** (-m)
    q, r = divmod(num, den)
    if decide_up(q, Fraction(r, den), sign, mode):
        q += 1
    if q >= 10 ** p:
        q //= 10
        e += 1
    return format_decimal(sign, q, e - p + 1)


def round_real(x, p, mode):
    """Correctly round any Real to p significant digits."""
    if isinstance(x, Rat):
        return round_fraction(x.f, p, mode)
    sgn = sign_of(x)
    ax = x if sgn > 0 else Neg(x)
    e = floor_log10_real(ax)
    m = p - 1 - e
    g = 10
    while True:
        k = max(m + g, 0)
        geff = k - m
        eps = Fraction(1, 10 ** geff)
        v = ax.approx(k) * pow10(m)
        q = v.numerator // v.denominator
        r = v - q
        on_boundary = (
            r <= eps
            or r >= 1 - eps
            or (mode in ("HALF_EVEN", "HALF_UP") and abs(r - Fraction(1, 2)) <= eps)
        )
        if on_boundary:
            if g < 1024:
                g *= 2
                continue
            # Value is exactly on the boundary (e.g. sqrt(2)*sqrt(2) == 2).
            if r <= eps:
                r = Fraction(0)
            elif r >= 1 - eps:
                q += 1
                r = Fraction(0)
            else:
                r = Fraction(1, 2)
        if decide_up(q, r, sgn, mode):
            q += 1
        if q >= 10 ** p:
            q //= 10
            e += 1
        return format_decimal(sgn, q, e - p + 1)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def main(argv):
    if len(argv) != 4:
        print("usage: python calc.py <expression> <precision> <mode>",
              file=sys.stderr)
        return 2
    _, expr, prec_s, mode = argv
    try:
        p = int(prec_s)
    except ValueError:
        print(f"error: invalid precision {prec_s!r}", file=sys.stderr)
        return 2
    if p <= 0:
        print("error: precision must be a positive integer", file=sys.stderr)
        return 2
    if mode not in MODES:
        print(f"error: invalid rounding mode {mode!r} "
              f"(expected one of {', '.join(MODES)})", file=sys.stderr)
        return 2
    try:
        value = evaluate(expr)
        out = round_real(value, p, mode)
    except CalcError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except ZeroDivisionError:
        print("error: division by zero", file=sys.stderr)
        return 2
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
