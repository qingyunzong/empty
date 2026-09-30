"""Exact round-to-nearest-even to IEEE 754 binary64 using Fraction."""

from fractions import Fraction

INF = float("inf")
NAN = float("nan")

_MAX_EXP = 1023
_MIN_NORMAL_EXP = -1022
_SUBNORMAL_SHIFT = 1074  # quantum of subnormals is 2^-1074
_PRECISION = 53


def _floor_log2(a):
    """floor(log2(a)) for a positive Fraction."""
    e = a.numerator.bit_length() - a.denominator.bit_length()
    if e >= 0:
        if a < Fraction(1 << e, 1):
            e -= 1
    else:
        if a < Fraction(1, 1 << -e):
            e -= 1
    return e


def _round_ties_even(scaled):
    """Round a non-negative Fraction to the nearest integer, ties to even."""
    n = scaled.numerator // scaled.denominator
    rem = scaled - n
    half = Fraction(1, 2)
    if rem > half or (rem == half and n % 2 == 1):
        n += 1
    return n


def round_binary64(x):
    """Round an exact Fraction to the nearest binary64 value (RNE).

    Returns an exact Fraction for finite results, or +/-INF on overflow.
    """
    if not isinstance(x, Fraction):
        x = Fraction(x)
    if x == 0:
        return Fraction(0)
    sign = 1 if x > 0 else -1
    a = abs(x)
    e = _floor_log2(a)
    if e >= _MIN_NORMAL_EXP:
        # Normal range: 53-bit significand, quantum 2^(e-52).
        shift = e - (_PRECISION - 1)
        q = Fraction(1 << shift) if shift >= 0 else Fraction(1, 1 << -shift)
        n = _round_ties_even(a / q)
        if n == 1 << _PRECISION:
            # Rounded up across a power-of-two boundary.
            n >>= 1
            q *= 2
            e += 1
        if e > _MAX_EXP:
            return INF if sign > 0 else -INF
        return Fraction(sign * n) * q
    # Subnormal range (or underflow to zero): quantum 2^-1074.
    q = Fraction(1, 1 << _SUBNORMAL_SHIFT)
    n = _round_ties_even(a / q)
    return Fraction(sign * n) * q


def half_ulp(v):
    """Half the ulp of the binary64 binade containing finite nonzero v."""
    a = abs(v)
    if a == 0:
        return Fraction(1, 1 << (_SUBNORMAL_SHIFT + 1))
    e = _floor_log2(a)
    if e >= _MIN_NORMAL_EXP:
        return Fraction(2) ** (e - (_PRECISION - 1) - 1)
    return Fraction(1, 1 << (_SUBNORMAL_SHIFT + 1))
