from fractions import Fraction

from realroots import poly as P


def poly_from_roots(*roots):
    p = (Fraction(1),)
    for r in roots:
        r = Fraction(r)
        p = P.mul(p, (-r, Fraction(1)))
    return p


def poly_pow(p, n):
    return P.pow_poly(p, n)


def linear(r):
    """x - r"""
    return (-Fraction(r), Fraction(1))


def root_record_contains(root, r):
    r = Fraction(r)
    if root["kind"] == "point":
        return root["lo"] == r
    return root["lo"] < r < root["hi"]
