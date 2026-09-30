"""Independent plain Euclidean GCD over QQ[x].

Deliberately naive (direct polynomial remainder sequence, no modular
techniques) so it can cross-check the modular implementation on small
examples without sharing code paths beyond basic arithmetic.
"""

from . import poly
from .reconstruct import to_primitive_zz


def euclid_gcd_qq(f, g):
    """Primitive positive-LC GCD of integer polynomials via QQ[x] Euclid."""
    f = poly.trim(list(f))
    g = poly.trim(list(g))
    if not f and not g:
        raise ValueError("gcd(0, 0) is undefined")
    if not f:
        return poly.normalize_primitive(g)
    if not g:
        return poly.normalize_primitive(f)
    a = poly.to_qq(f)
    b = poly.to_qq(g)
    while b:
        a, b = b, poly.divmod_qq(a, b)[1]
    return to_primitive_zz(poly.monic_qq(a))
