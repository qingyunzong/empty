"""Extended Euclidean algorithm over QQ[x] and Bezout certificates.

A certificate for gcd(f, g) = d is a triple (s, t, d) of QQ[x]
polynomials (d integral, primitive, positive leading coefficient) with

    s * f + t * g == d          (exact polynomial identity)
    d | f and d | g in QQ[x]
    deg s < deg g - deg d,  deg t < deg f - deg d

The verifier re-checks every condition independently of how the
certificate was produced; a forged or corrupted certificate is rejected.
"""

from fractions import Fraction

from . import poly


def _extended_gcd_qq(a, b):
    """Monic extended GCD over QQ[x]: returns (d, s, t), s*a + t*b == d."""
    old_r, r = list(a), list(b)
    old_s, s = [Fraction(1)], []
    old_t, t = [], [Fraction(1)]
    while r:
        q, rem = poly.divmod_qq(old_r, r)
        old_r, r = r, rem
        old_s, s = s, poly.sub(old_s, poly.mul(q, s))
        old_t, t = t, poly.sub(old_t, poly.mul(q, t))
    if not old_r:
        raise ValueError("gcd(0, 0) is undefined")
    inv = Fraction(1, 1) / old_r[-1]
    return (
        poly.scale(old_r, inv),
        poly.scale(old_s, inv),
        poly.scale(old_t, inv),
    )


def bezout_certificate(f, g, d):
    """Build a Bezout certificate for the primitive integer GCD ``d``.

    ``d`` must be the (primitive, positive-LC) GCD of ``f`` and ``g``;
    the certificate uses rational ``s, t`` with s*f + t*g == d exactly.
    """
    f = poly.trim(list(f))
    g = poly.trim(list(g))
    d = poly.trim(list(d))
    if not d:
        raise ValueError("zero GCD")
    d_monic, s_m, t_m = _extended_gcd_qq(poly.to_qq(f), poly.to_qq(g))
    # d_monic is monic; scale so the certified value equals integer d.
    # d = lc(d) * d_monic, so multiply the cofactors by lc(d).
    scale = Fraction(d[-1], 1)
    cert_s = poly.scale(s_m, scale)
    cert_t = poly.scale(t_m, scale)
    cert = {"s": cert_s, "t": cert_t, "d": [Fraction(c) for c in d]}
    if not verify_bezout(f, g, cert):
        raise AssertionError("internal error: generated certificate invalid")
    return cert


def _as_fractions(p):
    return poly.trim([Fraction(c) for c in p])


def verify_bezout(f, g, cert):
    """Independently verify a Bezout certificate.  Returns True/False."""
    try:
        f = _as_fractions(f)
        g = _as_fractions(g)
        s = _as_fractions(cert["s"])
        t = _as_fractions(cert["t"])
        d = _as_fractions(cert["d"])
    except (KeyError, TypeError, ValueError):
        return False
    if not d:
        return False
    # 1. d must be integral, primitive, positive leading coefficient.
    ints = []
    for c in d:
        if c.denominator != 1:
            return False
        ints.append(int(c))
    if poly.primitive_part(ints) != ints:
        return False
    # 2. the Bezout identity must hold exactly.
    if not poly.eq(poly.add(poly.mul(s, f), poly.mul(t, g)), d):
        return False
    # 3. d must divide both inputs over QQ.
    if poly.divmod_qq(f, d)[1]:
        return False
    if poly.divmod_qq(g, d)[1]:
        return False
    # 4. degree hygiene bounds of a minimal Bezout pair.
    dd = poly.degree(d)
    if s and poly.degree(s) > poly.degree(g) - dd:
        return False
    if t and poly.degree(t) > poly.degree(f) - dd:
        return False
    return True


def cert_to_json(cert):
    def rend(p):
        out = []
        for c in p:
            c = Fraction(c)
            out.append(str(c.numerator) if c.denominator == 1
                       else f"{c.numerator}/{c.denominator}")
        return out

    return {"s": rend(cert["s"]), "t": rend(cert["t"]), "d": rend(cert["d"])}


def cert_from_json(obj):
    def parse(p):
        out = []
        for c in p:
            if isinstance(c, str) and "/" in c:
                num, den = c.split("/", 1)
                out.append(Fraction(int(num), int(den)))
            else:
                out.append(Fraction(int(c)))
        return poly.trim(out)

    return {"s": parse(obj["s"]), "t": parse(obj["t"]), "d": parse(obj["d"])}
