"""CRT combination (incremental Garner) and rational reconstruction."""

from math import isqrt, gcd as _igcd
from fractions import Fraction


def crt_combine(value0, modulus0, value1, modulus1):
    """Combine x == value0 (mod modulus0) with x == value1 (mod modulus1).

    Moduli must be coprime.  Returns (x, modulus0 * modulus1) with
    0 <= x < modulus0 * modulus1.
    """
    t = ((value1 - value0 % modulus1) * pow(modulus0 % modulus1, -1, modulus1)) % modulus1
    return value0 + modulus0 * t, modulus0 * modulus1


def rational_reconstruct(residue, modulus):
    """Reconstruct a/b with a == residue * b (mod modulus).

    Succeeds (uniquely) when |a|, b <= sqrt(modulus / 2).  Returns a
    ``Fraction`` or ``None`` when no such small fraction exists.
    """
    residue %= modulus
    if residue == 0:
        return Fraction(0)
    bound = isqrt(modulus // 2)
    if bound < 1:
        return None
    r0, r1 = modulus, residue
    t0, t1 = 0, 1
    while r1 > bound:
        q = r0 // r1
        r0, r1 = r1, r0 - q * r1
        t0, t1 = t1, t0 - q * t1
    if r1 == 0 or t1 == 0:
        return None
    b = abs(t1)
    a = r1 if t1 > 0 else -r1
    if b > bound:
        return None
    if _igcd(abs(a), b) != 1:
        return None
    return Fraction(a, b)


def reconstruct_monic_poly(residues, modulus):
    """Rationally reconstruct every coefficient of a monic polynomial.

    ``residues`` are the CRT images (mod ``modulus``) of the coefficients,
    leading coefficient 1 implied.  Returns a monic QQ[x] polynomial or
    ``None`` if any coefficient fails reconstruction.
    """
    out = []
    for r in residues:
        c = rational_reconstruct(r, modulus)
        if c is None:
            return None
        out.append(c)
    out.append(Fraction(1))
    return out


def to_primitive_zz(monic_rational):
    """Convert a monic QQ[x] polynomial to its primitive ZZ[x] form."""
    from .poly import primitive_part

    den = 1
    for c in monic_rational:
        den = den * c.denominator // _igcd(den, c.denominator)
    ints = [int(c * den) for c in monic_rational]
    return primitive_part(ints)
