"""radb: a mini relational database with cost-based left-deep join ordering."""

from .engine import RadbError, run

__all__ = ["RadbError", "run"]
