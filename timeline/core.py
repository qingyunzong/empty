"""Core value types for the timeline library.

Three distinct notions of "time" are modelled and must never be conflated:

* ``Instant``       -- a unique point on the UTC timeline (epoch seconds).
* ``LocalDateTime`` -- a wall-clock reading, with no offset attached.  A
                       wall-clock reading may name zero, one or two instants
                       depending on the offset transition table.
* ``Duration``      -- an exact number of timeline seconds.  A Duration is
                       NOT a calendar quantity: 86400 seconds is not the same
                       thing as "one wall-clock day" across an offset jump.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

NAIVE_EPOCH = datetime(1970, 1, 1)


@dataclass(frozen=True, order=True)
class Instant:
    """A unique point on the UTC timeline, stored as epoch seconds."""

    epoch_seconds: int

    @staticmethod
    def from_iso(text: str) -> "Instant":
        body = text.strip()
        if body.endswith("Z"):
            body = body[:-1] + "+00:00"
        dt = datetime.fromisoformat(body)
        if dt.tzinfo is None:
            raise ValueError("instant requires an explicit UTC offset (use 'Z')")
        return Instant(int(dt.timestamp()))

    def to_iso(self) -> str:
        dt = datetime.fromtimestamp(self.epoch_seconds, tz=timezone.utc)
        return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass(frozen=True, order=True)
class LocalDateTime:
    """A naive wall-clock reading.  Carries no offset information."""

    naive: datetime

    def __post_init__(self) -> None:
        if self.naive.tzinfo is not None:
            raise ValueError("LocalDateTime must be naive (no tzinfo)")

    @staticmethod
    def from_iso(text: str) -> "LocalDateTime":
        dt = datetime.fromisoformat(text.strip())
        return LocalDateTime(dt)

    @staticmethod
    def from_local_seconds(seconds: int) -> "LocalDateTime":
        return LocalDateTime(NAIVE_EPOCH + timedelta(seconds=seconds))

    def local_seconds(self) -> int:
        """Seconds of this wall-clock reading on the naive local axis."""
        delta = self.naive - NAIVE_EPOCH
        return delta.days * 86400 + delta.seconds

    def to_iso(self) -> str:
        return self.naive.strftime("%Y-%m-%dT%H:%M:%S")


@dataclass(frozen=True)
class Duration:
    """An exact count of timeline seconds (may be negative)."""

    seconds: int

    def __add__(self, other: "Duration") -> "Duration":
        return Duration(self.seconds + other.seconds)
