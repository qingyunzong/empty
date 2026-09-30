"""winsync: pull records from a read-only segment log with a sliding
validation window, exactly-once DST delivery and ACK-based recovery."""

from .core import (
    PullError,
    PullResult,
    discover_segments,
    format_segment,
    load_payload,
    parse_segment_name,
    pull,
    read_ack,
    write_ack,
)

__all__ = [
    "PullError",
    "PullResult",
    "discover_segments",
    "format_segment",
    "load_payload",
    "parse_segment_name",
    "pull",
    "read_ack",
    "write_ack",
]

__version__ = "0.1.0"
