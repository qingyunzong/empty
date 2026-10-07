"""timeaxis: explicit-transition-table time axis library.

Separates Instant (unique UTC timeline point), LocalDateTime (wall clock)
and Duration (elapsed seconds), and resolves wall-clock readings through an
explicit, ordered UTC-offset transition table.
"""
from .core import (
    Candidate,
    Duration,
    Instant,
    LocalDateTime,
    Segment,
    TableError,
    TransitionTable,
    UtcInterval,
    format_offset,
    parse_offset,
)
from .timeline import Snapshot, Timeline

__all__ = [
    "Candidate",
    "Duration",
    "Instant",
    "LocalDateTime",
    "Segment",
    "Snapshot",
    "TableError",
    "Timeline",
    "TransitionTable",
    "UtcInterval",
    "format_offset",
    "parse_offset",
]
