"""Exact real-root isolation for rational polynomials.

Pure Python 3.11 standard library.  All arithmetic is exact
(``fractions.Fraction``); no numerical root-finding is used anywhere.
"""
from .budget import Budget, BudgetExhausted
from .certificate import build_certificate, verify_certificate
from .compare import compare_roots
from .isolate import IsolationSession, Root, isolate, refine_to
from .poly import Poly, parse_rational
from .sturm import sign_variations, sturm_sequence

__all__ = [
    "Budget", "BudgetExhausted",
    "Poly", "parse_rational",
    "sturm_sequence", "sign_variations",
    "IsolationSession", "Root", "isolate", "refine_to",
    "compare_roots",
    "build_certificate", "verify_certificate",
]
