"""Symbolic DFA minimization by partition refinement over integer
character intervals."""

from .automaton import SymbolicDFA
from .certificate import verify_certificate
from .intervals import IntervalError
from .minimizer import Minimizer, minimize
from .partition import StabilityError

__all__ = [
    "SymbolicDFA",
    "Minimizer",
    "minimize",
    "verify_certificate",
    "IntervalError",
    "StabilityError",
]
