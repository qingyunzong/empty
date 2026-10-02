"""Timezone-aware calendar helpers.

All real instants are UTC epoch seconds (float/int). Business-day and
calendar windows are derived from *local* day boundaries in a named IANA
timezone, so a "day" may be 23/24/25 hours long around DST transitions.
We never assume 86400 seconds per day.
"""
from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
from functools import lru_cache
from zoneinfo import ZoneInfo


@lru_cache(maxsize=None)
def load_timezone(name: str) -> ZoneInfo:
    """Load and validate an IANA timezone name."""
    if not isinstance(name, str) or not name:
        raise ValueError(f"invalid timezone name: {name!r}")
    return ZoneInfo(name)  # raises ZoneInfoNotFoundError for bad names


def to_local(ts: float, tz_name: str) -> datetime:
    return datetime.fromtimestamp(ts, tz=timezone.utc).astimezone(load_timezone(tz_name))


def local_day_bounds(ts: float, tz_name: str) -> tuple[datetime, datetime]:
    """Return (start, end) local datetimes of the local day containing ``ts``.

    The bounds are timezone-aware; their UTC epoch difference is the true
    length of that local day (e.g. 90000s on a fall-back day in
    America/New_York, 82800s on a spring-forward day).
    """
    tz = load_timezone(tz_name)
    local = datetime.fromtimestamp(ts, tz=timezone.utc).astimezone(tz)
    start = datetime.combine(local.date(), time.min, tzinfo=tz)
    end = datetime.combine(local.date() + timedelta(days=1), time.min, tzinfo=tz)
    return start, end


def local_day_length_seconds(ts: float, tz_name: str) -> float:
    start, end = local_day_bounds(ts, tz_name)
    return end.timestamp() - start.timestamp()


def day_key(ts: float, tz_name: str) -> str:
    """Bucket key for the local business day containing instant ``ts``."""
    return to_local(ts, tz_name).date().isoformat()


def week_key(ts: float, tz_name: str) -> str:
    """Bucket key for the local ISO week containing instant ``ts``."""
    iso = to_local(ts, tz_name).date().isocalendar()
    return f"{iso.year}-W{iso.week:02d}"


def month_key(ts: float, tz_name: str) -> str:
    """Bucket key for the local calendar month containing instant ``ts``."""
    d = to_local(ts, tz_name).date()
    return f"{d.year:04d}-{d.month:02d}"
