"""polygcd: modular gcd of integer polynomials with verifiable results."""

from .polynomial import (
    trim,
    is_zero,
    degree,
    lc,
    add,
    sub,
    mul,
    mul_scalar,
    content,
    primitive_part,
    content_pp,
    exact_div,
)
from .modular import mod_poly, gcd_mod_p, crt_pair, crt_polys
from .rational import (
    rational_reconstruct,
    clear_denominators,
    gcd_rational,
    integer_gcd_rational,
)
from .bezout import extended_gcd_rational, verify_bezout
from .engine import ModularGCDEngine

__all__ = [
    "trim",
    "is_zero",
    "degree",
    "lc",
    "add",
    "sub",
    "mul",
    "mul_scalar",
    "content",
    "primitive_part",
    "content_pp",
    "exact_div",
    "mod_poly",
    "gcd_mod_p",
    "crt_pair",
    "crt_polys",
    "rational_reconstruct",
    "clear_denominators",
    "gcd_rational",
    "integer_gcd_rational",
    "extended_gcd_rational",
    "verify_bezout",
    "ModularGCDEngine",
]
