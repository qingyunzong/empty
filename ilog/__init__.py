"""ilog: persistent half-open interval sets in a single JSON file."""

from .core import (
    BAD_INTERVAL,
    FAULT_POINTS,
    IO,
    ILogError,
    InjectedFault,
    IntervalStore,
    clear_fault,
    set_fault,
)

__all__ = [
    "BAD_INTERVAL",
    "FAULT_POINTS",
    "IO",
    "ILogError",
    "InjectedFault",
    "IntervalStore",
    "clear_fault",
    "set_fault",
]

__version__ = "0.1.0"
