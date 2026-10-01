"""latefix: rolling-window stream with bounded-lateness corrections."""

from .core import ADD, RETRACT, Event, Record, run_reference, run_stream
from .io import InputError, parse_line

__all__ = [
    "ADD",
    "RETRACT",
    "Event",
    "Record",
    "InputError",
    "parse_line",
    "run_reference",
    "run_stream",
]

__version__ = "0.1.0"
