"""Modular integer polynomial GCD with verifiable certificates.

Public API:
    gcd_modular        -- certified modular GCD over ZZ[x]
    bezout_certificate -- extended-GCD Bezout certificate over QQ[x]
    verify_bezout      -- independent certificate verifier
    euclid_gcd_qq      -- independent plain rational Euclidean GCD
"""

from .modular_gcd import gcd_modular, GCDResult, BudgetExhausted
from .bezout import bezout_certificate, verify_bezout
from .euclid import euclid_gcd_qq

__all__ = [
    "gcd_modular",
    "GCDResult",
    "BudgetExhausted",
    "bezout_certificate",
    "verify_bezout",
    "euclid_gcd_qq",
]
