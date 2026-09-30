"""Nested-scope budget authorization with shared quotas, staged
reservations, constraint-based allocation, WAL recovery and interleaving
model checking."""

from .engine import Authorizer
from . import solver, interleave

__all__ = ["Authorizer", "solver", "interleave"]
