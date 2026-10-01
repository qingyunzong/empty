"""radb: a tiny relational query engine with a cost-based join optimizer."""
from .engine import RadbError, run_query

__all__ = ["RadbError", "run_query"]
