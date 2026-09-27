"""Correctly-rounded decimal calculator.

Expression is evaluated exactly with fractions.Fraction for +, -, *, /.
sqrt() is correctly rounded to p significant digits using exact integer
arithmetic (math.isqrt), never truncated.  The final result is rounded to
p significant decimal digits with the requested rounding mode.

CLI:
    python calc.py <expression> <precision> <mode>

Modes: HALF_EVEN, HALF_UP, DOWN, FLOOR
Exit code 2 on invalid mode, precision <= 0, or any evaluation error.
"""

from __future__ import annotations

import ast
import math
import sys
from fractions import Fraction

MODES = ("HALF_EVEN", "HALF_UP", "DOWN", "FLOOR")

TEN = Fraction(10)


class CalcError(Exception):
    """Any user-facing error (exit code 2)."""


def _pow10(n: int) -> Fraction:
    return TEN ** n if n >= 0 else Fraction(1, 10 ** (-n))


def decimal_exponent(a: Fraction) -> int:
    """Return e such that 10**e <= a < 10**(e+1), for a > 0."""
    if a <= 0:
        raise CalcError("decimal_exponent requires a positive value")
    e = len(str(a.numerator)) - len(str(a.denominator))
    while a < _pow10(e):
        e -= 1
    while a >= _pow10(e + 1):
        e += 1
    return e


def _round_quotient_to_int(q: Fraction, mode: str) -> int:
    """Round a non-negative Fraction to an integer per mode.

    Mode is interpreted for a non-negative magnitude:
    DOWN -> truncate, FLOOR -> floor (same here), HALF_UP -> half away
    from zero, HALF_EVEN -> banker's rounding.
    """
    f, r = divmod(q.numerator, q.denominator)
    if r == 0:
        return f
    if mode in ("DOWN", "FLOOR"):
        return f
    twice = 2 * r
    if twice > q.denominator:
        return f + 1
    if twice < q.denominator:
        return f
    # exact tie
    if mode == "HALF_UP":
        return f + 1
    # HALF_EVEN
    return f + 1 if f % 2 == 1 else f


def round_fraction(v: Fraction, p: int, mode: str) -> Fraction:
    """Correctly round exact Fraction v to p significant decimal digits."""
    if p <= 0:
        raise CalcError("precision must be a positive integer")
    if mode not in MODES:
        raise CalcError(f"invalid rounding mode: {mode!r}")
    if v == 0:
        return Fraction(0)
    sign = 1 if v > 0 else -1
    a = abs(v)
    e = decimal_exponent(a)
    k = p - 1 - e
    scaled = a * _pow10(k)
    if mode == "FLOOR" and sign < 0:
        # FLOOR on a negative value rounds away from zero in magnitude.
        f, r = divmod(scaled.numerator, scaled.denominator)
        m = f + 1 if r else f
    else:
        m = _round_quotient_to_int(scaled, mode)
    return Fraction(sign * m) * _pow10(-k)


def sqrt_rounded(x: Fraction, p: int, mode: str) -> Fraction:
    """Correctly rounded sqrt(x) to p significant digits, exact arithmetic."""
    if p <= 0:
        raise CalcError("precision must be a positive integer")
    if mode not in MODES:
        raise CalcError(f"invalid rounding mode: {mode!r}")
    if x < 0:
        raise CalcError("sqrt of a negative number")
    if x == 0:
        return Fraction(0)
    def _pow100(n: int) -> Fraction:
        return Fraction(100) ** n if n >= 0 else Fraction(1, 100 ** (-n))

    # Find t with 100**t <= x < 100**(t+1); then 10**t <= sqrt(x) < 10**(t+1).
    t = (len(str(x.numerator)) - len(str(x.denominator))) // 2
    while x < _pow100(t):
        t -= 1
    while x >= _pow100(t + 1):
        t += 1
    e = t  # decimal exponent of sqrt(x)
    k = p - 1 - e
    # m = floor(sqrt(x) * 10**k), computed exactly.
    scaled_sq = x * _pow10(2 * k)  # = (sqrt(x) * 10**k)**2
    m = math.isqrt(scaled_sq.numerator // scaled_sq.denominator)
    # Decide rounding by exact comparison of sqrt(x)*10**k with m + 1/2,
    # i.e. compare 4 * scaled_sq with (2m + 1)**2.
    lhs = 4 * scaled_sq
    rhs = Fraction((2 * m + 1) ** 2)
    if lhs == rhs:
        # exact tie
        if mode in ("DOWN", "FLOOR"):
            mr = m
        elif mode == "HALF_UP":
            mr = m + 1
        else:  # HALF_EVEN
            mr = m + 1 if m % 2 == 1 else m
    elif lhs > rhs:
        mr = m if mode in ("DOWN", "FLOOR") else m + 1
    else:
        mr = m
    return Fraction(mr) * _pow10(-k)


def format_decimal(v: Fraction, p: int) -> str:
    """Format a value already rounded to p significant digits as a string."""
    if v == 0:
        return "0"
    sign = "-" if v < 0 else ""
    a = abs(v)
    e = decimal_exponent(a)
    k = p - 1 - e
    m_frac = a * _pow10(k)
    m = m_frac.numerator // m_frac.denominator
    digits = str(m).zfill(p)
    if e >= p or e < -4:
        # scientific notation
        if p == 1:
            mantissa = digits[0]
        else:
            mantissa = digits[0] + "." + digits[1:]
        return f"{sign}{mantissa}e{'+' if e >= 0 else ''}{e}"
    if e >= 0:
        intpart = digits[: e + 1]
        frac = digits[e + 1 :]
        return f"{sign}{intpart}.{frac}" if frac else f"{sign}{intpart}"
    return f"{sign}0.{'0' * (-e - 1)}{digits}"


def _eval_node(node, p: int, mode: str) -> Fraction:
    if isinstance(node, ast.Expression):
        return _eval_node(node.body, p, mode)
    if isinstance(node, ast.Constant):
        if isinstance(node.value, bool) or not isinstance(node.value, (int, float)):
            raise CalcError("only numeric literals are allowed")
        return Fraction(node.value) if isinstance(node.value, int) else Fraction(str(node.value))
    if isinstance(node, ast.BinOp):
        left = _eval_node(node.left, p, mode)
        right = _eval_node(node.right, p, mode)
        if isinstance(node.op, ast.Add):
            return left + right
        if isinstance(node.op, ast.Sub):
            return left - right
        if isinstance(node.op, ast.Mult):
            return left * right
        if isinstance(node.op, ast.Div):
            if right == 0:
                raise CalcError("division by zero")
            return left / right
        raise CalcError("unsupported operator")
    if isinstance(node, ast.UnaryOp):
        operand = _eval_node(node.operand, p, mode)
        if isinstance(node.op, ast.USub):
            return -operand
        if isinstance(node.op, ast.UAdd):
            return operand
        raise CalcError("unsupported unary operator")
    if isinstance(node, ast.Call):
        if (
            isinstance(node.func, ast.Name)
            and node.func.id == "sqrt"
            and len(node.args) == 1
            and not node.keywords
        ):
            return sqrt_rounded(_eval_node(node.args[0], p, mode), p, mode)
        raise CalcError("only sqrt(x) calls are allowed")
    raise CalcError("unsupported expression")


def evaluate(expression: str, p: int, mode: str) -> Fraction:
    if p <= 0:
        raise CalcError("precision must be a positive integer")
    if mode not in MODES:
        raise CalcError(f"invalid rounding mode: {mode!r}")
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError as exc:
        raise CalcError(f"invalid expression: {exc}") from exc
    return _eval_node(tree, p, mode)


def run(expression: str, p: int, mode: str) -> str:
    value = evaluate(expression, p, mode)
    rounded = round_fraction(value, p, mode)
    return format_decimal(rounded, p)


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print("usage: python calc.py <expression> <precision> <mode>", file=sys.stderr)
        return 2
    expression, prec_s, mode = argv[1], argv[2], argv[3]
    try:
        p = int(prec_s)
    except ValueError:
        print(f"error: precision must be an integer, got {prec_s!r}", file=sys.stderr)
        return 2
    try:
        out = run(expression, p, mode)
    except CalcError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
