"""Sessionize: per-key event-time sessionization with watermarks and retractions."""

from .core import (
    ADD,
    RETRACT,
    Session,
    ids_hash,
    process_events,
    sessionize,
)

__all__ = [
    "ADD",
    "RETRACT",
    "Session",
    "ids_hash",
    "process_events",
    "sessionize",
]

__version__ = "0.1.0"
