"""retractop: event-time windowed Top-K with retraction support."""

from .core import ADD, RETRACT, BadLineError, Engine, parse_event

__all__ = ["ADD", "RETRACT", "BadLineError", "Engine", "parse_event"]
__version__ = "0.1.0"
