"""dpor: dynamic partial-order reduction explorer for shared-memory programs."""

from .model import ProgramError, validate_program, dependent
from .explorer import Explorer, explore_program

__all__ = [
    "ProgramError",
    "validate_program",
    "dependent",
    "Explorer",
    "explore_program",
]

__version__ = "0.1.0"
