"""gpupack: deterministic discrete-time GPU job scheduler."""

from .model import Problem, ProblemError, parse_problem
from .scheduler import Solution, solve

__all__ = ["Problem", "ProblemError", "parse_problem", "Solution", "solve"]
__version__ = "0.1.0"
