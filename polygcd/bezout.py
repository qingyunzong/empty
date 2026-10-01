"""Extended gcd over Q[x] with independently verifiable Bezout certificates."""

from fractions import Fraction

from .polynomial import trim
from .rational import to_rational, r_trim, r_add, r_sub, r_mul, r_divmod


def extended_gcd_rational(f, g):
    """Return (d, s, t) over Q with s*f + t*g == d and d monic (or all zero)."""
    a, b = to_rational(trim(f)), to_rational(trim(g))
    s0, s1 = (Fraction(1),), ()
    t0, t1 = (), (Fraction(1),)
    while b:
        q, r = r_divmod(a, b)
        a, b = b, r
        s0, s1 = s1, r_trim(r_sub(s0, r_mul(q, s1)))
        t0, t1 = t1, r_trim(r_sub(t0, r_mul(q, t1)))
    if not a:
        return (), (), ()
    lead = a[-1]
    return (
        tuple(c / lead for c in a),
        tuple(c / lead for c in s0),
        tuple(c / lead for c in t0),
    )


def verify_bezout(f, g, s, t, d):
    """Independently verify a Bezout certificate using plain rational
    arithmetic only:
      1. s*f + t*g == d as polynomials over Q;
      2. d is monic unless it is zero;
      3. d divides both f and g over Q.
    """
    fp, gp = to_rational(trim(f)), to_rational(trim(g))
    s, t, d = r_trim(s), r_trim(t), r_trim(d)
    lhs = r_trim(r_add(r_mul(s, fp), r_mul(t, gp)))
    if lhs != d:
        return False
    if not d:
        return not fp and not gp
    if d[-1] != 1:
        return False
    for h in (fp, gp):
        if not h:
            continue
        _, rem = r_divmod(h, d)
        if rem:
            return False
    return True
