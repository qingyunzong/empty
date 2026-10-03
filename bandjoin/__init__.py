"""bandjoin: band join of two event streams with per-side watermarks."""

from .core import BandJoin
from .cli import InputError, main, parse_line, read_stream, run_join

__all__ = [
    "BandJoin",
    "InputError",
    "main",
    "parse_line",
    "read_stream",
    "run_join",
]

__version__ = "1.0.0"
