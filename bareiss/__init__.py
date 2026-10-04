"""Exact linear algebra over the integers via Bareiss elimination."""
from .core import (
    BareissIntegralityError,
    Factorization,
    LinearSystem,
)

__all__ = ["BareissIntegralityError", "Factorization", "LinearSystem"]
__version__ = "1.0.0"
