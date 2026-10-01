"""ticketpool: deterministic tick-based multi-worker ticket scheduler."""

from .sim import ValidationError, serve

__all__ = ["ValidationError", "serve"]
__version__ = "0.1.0"
