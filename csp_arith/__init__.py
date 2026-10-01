"""Offline CSP library for integer binary arithmetic constraints.

Supports the constraint types lt / le / eq / ne with arc-consistency
propagation and lazily generated minimal removal explanations.
Allowed value pairs are never pre-generated; domain support checks are
computed on the fly from the current domains.
"""

from .model import Problem, ProblemError, load_problem
from .solver import Propagator

__all__ = ["Problem", "ProblemError", "load_problem", "Propagator"]
