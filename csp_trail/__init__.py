"""CSP solver with trail-based backtracking and a small CLI."""

from .core import (
    CSPError,
    InvalidLevelError,
    TrailCSP,
    UnknownVariableError,
    ValueNotInDomainError,
    load_problem,
)

__all__ = [
    "CSPError",
    "InvalidLevelError",
    "TrailCSP",
    "UnknownVariableError",
    "ValueNotInDomainError",
    "load_problem",
]
