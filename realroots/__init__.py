"""Exact real-root isolation for polynomials over the rationals.

Everything is computed with exact rational arithmetic (fractions.Fraction):
squarefree factorization, Sturm sequences, root isolation into rational
intervals, budgeted resumable runs, comparison of algebraic numbers via
GCD and joint isolation, and verifiable certificates.
"""

from . import poly, sturm
from .algebraic import AlgebraicNumber, compare
from .certificate import build_certificate, make_certificate
from .isolate import Engine, finalize, isolate, isolate_squarefree, refine_root, run
from .verify import verify_certificate

__all__ = [
    "poly", "sturm", "AlgebraicNumber", "compare", "Engine", "run",
    "isolate", "isolate_squarefree", "finalize", "refine_root",
    "build_certificate", "make_certificate", "verify_certificate",
]
