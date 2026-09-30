"""wmagg: watermark-based rolling-window aggregation over JSONL events."""

from .core import Event, InputError, WindowAggregator, parse_event

__all__ = ["Event", "InputError", "WindowAggregator", "parse_event"]
__version__ = "0.1.0"
