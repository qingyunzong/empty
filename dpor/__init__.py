"""dpor: dynamic partial-order reduction for small shared-memory programs."""

from .core import (
    MAX_OPS_PER_THREAD,
    MAX_THREADS,
    Op,
    Program,
    ProgramError,
    State,
    Thread,
    dependent,
    enabled,
    parse_program,
    step,
)
from .explore import Result, explore

__version__ = "0.1.0"

__all__ = [
    "MAX_OPS_PER_THREAD",
    "MAX_THREADS",
    "Op",
    "Program",
    "ProgramError",
    "Result",
    "State",
    "Thread",
    "dependent",
    "enabled",
    "explore",
    "parse_program",
    "step",
    "__version__",
]
