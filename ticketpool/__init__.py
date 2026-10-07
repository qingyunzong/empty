"""ticketpool: deterministic tick-based ticket scheduling with group quotas and aging."""

from .scheduler import serve

__all__ = ["serve"]
__version__ = "1.0.0"
