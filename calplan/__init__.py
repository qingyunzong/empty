"""calplan: earliest contiguous scheduling over UTC working days."""

from .core import BadInputError, plan

__all__ = ["plan", "BadInputError"]
