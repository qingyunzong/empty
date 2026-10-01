"""dedupwin: bounded-skew streaming dedup over event-time windows."""

from .core import DedupWin, MissingFieldError

__all__ = ["DedupWin", "MissingFieldError"]
__version__ = "0.1.0"
