"""fairq: deterministic weighted-DRF flow scheduler simulator."""

from .simulator import DEFAULT_WINDOW, SimError, simulate, normalize_events

__all__ = ["DEFAULT_WINDOW", "SimError", "simulate", "normalize_events"]
__version__ = "0.1.0"
