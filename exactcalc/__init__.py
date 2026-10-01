"""Exact computation with huge integers and algebraic numbers.

No floating point is ever used to decide a boundary: integer k-th roots
come with verifiable comparison evidence, and algebraic numbers are
handled through rational isolating intervals with exact sign tests.
"""
from .algebraic import AlgebraicError, AlgebraicNumber
from .cache import EvidenceCache, EvidenceError
from .introot import (
    int_kth_root_floor,
    pow_cap,
    root_evidence,
    verify_root_evidence,
)
from .polys import round_half_even_fraction

__all__ = [
    "AlgebraicError",
    "AlgebraicNumber",
    "EvidenceCache",
    "EvidenceError",
    "int_kth_root_floor",
    "pow_cap",
    "root_evidence",
    "round_half_even_fraction",
    "verify_root_evidence",
]
