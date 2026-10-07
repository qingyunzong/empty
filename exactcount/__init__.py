"""exactcount: exact solution counting for finite integer domains with
allowed-tuple table constraints, under a resumable support-check budget."""

from .checker import verify_certificate
from .problem import Problem, ProblemError
from .solver import Solver

__all__ = ["Problem", "ProblemError", "Solver", "verify_certificate"]
__version__ = "1.0.0"
