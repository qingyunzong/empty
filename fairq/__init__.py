"""fairq: deterministic fair-queueing simulator (weighted DRF)."""

from .simulator import DEFAULT_CAPACITY, STARVE_WINDOW, SimError, simulate, validate_events

__all__ = [
    "DEFAULT_CAPACITY",
    "STARVE_WINDOW",
    "SimError",
    "simulate",
    "validate_events",
]
