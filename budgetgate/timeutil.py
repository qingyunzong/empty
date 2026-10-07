"""Time helpers.

All instants are timezone-aware ``datetime`` objects normalised to UTC.
Business-day and other calendar boundaries are always derived through
``zoneinfo`` local-time arithmetic -- never by adding a fixed 86400 seconds,
which would be wrong across DST transitions.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

UTC = timezone.utc


def parse_ts(value) -> datetime:
    """Parse an ISO-8601 string (or pass through a datetime) to UTC."""
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, str):
        dt = datetime.fromisoformat(value)
    else:
        raise ValueError(f"unsupported timestamp: {value!r}")
    if dt.tzinfo is None:
        raise ValueError("timestamp must carry an explicit timezone offset")
    return dt.astimezone(UTC)


def fmt_ts(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat()


class TimezoneTable:
    """Named timezone table referenced by calendar-window rules."""

    def __init__(self, mapping: dict[str, str]):
        self._mapping = dict(mapping)
        self._zones: dict[str, ZoneInfo] = {}
        for alias, iana_name in self._mapping.items():
            self._zones[alias] = ZoneInfo(iana_name)  # raises on bad name

    def zone(self, alias: str) -> ZoneInfo:
        try:
            return self._zones[alias]
        except KeyError:
            raise KeyError(f"unknown timezone alias: {alias!r}") from None

    def to_dict(self) -> dict[str, str]:
        return dict(self._mapping)


def local_day_bounds(tz: ZoneInfo, day: date) -> tuple[datetime, datetime]:
    """UTC instants of local midnight at the start and end of ``day``.

    On DST transition days the span is 23 or 25 hours, not 86400 seconds;
    the bounds are computed by localising midnights, so they stay correct.
    """
    start = datetime.combine(day, time.min, tzinfo=tz).astimezone(UTC)
    end = datetime.combine(day + timedelta(days=1), time.min, tzinfo=tz).astimezone(UTC)
    return start, end
