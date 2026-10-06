"""Timeline library: Instant / LocalDateTime / Duration with explicit,
revisable UTC-offset transition tables."""
from .core import Duration, Instant, LocalDateTime
from .table import MappingCache, OffsetTable, Segment, Snapshot
from .mapping import (Candidate, instant_to_local, local_to_instant,
                      verify_candidate)
from .intervals import (IntervalResult, LocalGap, LocalInterval, UtcPiece,
                        convert_interval)
from .arithmetic import (add_days_wallclock, add_duration,
                         add_months_wallclock, add_seconds_timeline)

__all__ = [
    "Duration", "Instant", "LocalDateTime",
    "MappingCache", "OffsetTable", "Segment", "Snapshot",
    "Candidate", "instant_to_local", "local_to_instant", "verify_candidate",
    "IntervalResult", "LocalGap", "LocalInterval", "UtcPiece",
    "convert_interval",
    "add_days_wallclock", "add_duration", "add_months_wallclock",
    "add_seconds_timeline",
]
