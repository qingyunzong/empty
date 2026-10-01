"""Offline integer binary arithmetic constraint propagation library.

Supports the constraint types lt / le / eq / ne over integer variables
with enumerated domains.  Propagation computes domain-support relations
lazily (no pregenerated allowed-value tuples) and records a minimal
explanation for every pruned value.
"""

from .core import (
    CONSTRAINT_TYPES,
    Conflict,
    ProblemError,
    Propagator,
    propagate,
)
from .model import load_problem, validate_problem

__all__ = [
    "CONSTRAINT_TYPES",
    "Conflict",
    "ProblemError",
    "Propagator",
    "propagate",
    "load_problem",
    "validate_problem",
]

__version__ = "1.0.0"
