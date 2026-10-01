"""memjoin: memory-constrained equi-join planner and executor."""

from .planner import plan_query
from .executor import run_query

__all__ = ["plan_query", "run_query"]
__version__ = "0.1.0"
