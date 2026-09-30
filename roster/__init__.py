"""Hierarchical roster solver with per-level rollback."""

from .core import BAD_ROSTER, RosterError, solve

__all__ = ["BAD_ROSTER", "RosterError", "solve"]
__version__ = "0.1.0"
