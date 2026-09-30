"""Core scheduling logic for calplan.

Splits a demand of ``duration_min`` minutes into the earliest contiguous
segments that lie entirely inside working days (``week``), skip holiday
dates, and avoid half-open ``busy`` intervals, all within the half-open
candidate window ``[start, end)``. Everything is computed in UTC.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

UTC = timezone.utc

_WEEKDAYS = {
    "mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6,
}

REQUIRED_FIELDS = ("week", "holidays", "busy", "duration_min", "start", "end")


class BadInput(ValueError):
    """Raised when the request payload is invalid."""

    code = "BAD_INPUT"


def _parse_dt(value, field):
    if not isinstance(value, str):
        raise BadInput(f"{field} must be an ISO 8601 timestamp string")
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        raise BadInput(f"{field} is not a valid ISO 8601 timestamp: {value!r}")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _parse_date(value, field):
    if not isinstance(value, str):
        raise BadInput(f"{field} entries must be ISO 8601 date strings")
    try:
        return date.fromisoformat(value.strip())
    except ValueError:
        raise BadInput(f"invalid date in {field}: {value!r}")


def _parse_week(value):
    if isinstance(value, (str, bytes)) or not isinstance(value, (list, tuple, set)):
        raise BadInput("week must be a list of weekday names or integers 0-6")
    days = set()
    for item in value:
        if isinstance(item, bool):
            raise BadInput(f"invalid weekday entry: {item!r}")
        if isinstance(item, int):
            if 0 <= item <= 6:
                days.add(item)
            else:
                raise BadInput(f"weekday integer out of range 0-6: {item!r}")
        elif isinstance(item, str):
            key = item.strip().lower()[:3]
            if key in _WEEKDAYS:
                days.add(_WEEKDAYS[key])
            else:
                raise BadInput(f"unknown weekday name: {item!r}")
        else:
            raise BadInput(f"invalid weekday entry: {item!r}")
    return days


def _parse_duration(value):
    if isinstance(value, bool) or not isinstance(value, int):
        raise BadInput("duration_min must be a non-negative integer")
    if value < 0:
        raise BadInput("duration_min must be non-negative")
    return value


def _parse_busy(value, start, end):
    if not isinstance(value, (list, tuple)):
        raise BadInput("busy must be a list of [start, end] pairs")
    intervals = []
    for index, item in enumerate(value):
        if not isinstance(item, (list, tuple)) or len(item) != 2:
            raise BadInput(f"busy[{index}] must be a [start, end] pair")
        busy_start = _parse_dt(item[0], f"busy[{index}][0]")
        busy_end = _parse_dt(item[1], f"busy[{index}][1]")
        if busy_start >= busy_end:
            raise BadInput(f"busy[{index}] has start >= end")
        clipped_start = max(busy_start, start)
        clipped_end = min(busy_end, end)
        if clipped_start < clipped_end:
            intervals.append((clipped_start, clipped_end))
    intervals.sort()
    return intervals


def _subtract_busy(work_start, work_end, busy):
    parts = [(work_start, work_end)]
    for busy_start, busy_end in busy:
        if busy_end <= work_start or busy_start >= work_end:
            continue
        remaining = []
        for part_start, part_end in parts:
            if busy_end <= part_start or busy_start >= part_end:
                remaining.append((part_start, part_end))
                continue
            if part_start < busy_start:
                remaining.append((part_start, busy_start))
            if busy_end < part_end:
                remaining.append((busy_end, part_end))
        parts = remaining
        if not parts:
            break
    return parts


def free_intervals(start, end, week, holidays, busy):
    """Return sorted half-open free intervals inside [start, end)."""
    intervals = []
    one_day = timedelta(days=1)
    day = start.date()
    last_day = end.date()
    while day <= last_day:
        if day.weekday() in week and day not in holidays:
            day_start = datetime(day.year, day.month, day.day, tzinfo=UTC)
            seg_start = max(day_start, start)
            seg_end = min(day_start + one_day, end)
            if seg_start < seg_end:
                intervals.extend(_subtract_busy(seg_start, seg_end, busy))
        day += one_day
    intervals.sort()
    return intervals


def iso(dt):
    """Format a UTC datetime as ISO 8601 with a Z suffix."""
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


def plan(payload):
    """Compute the earliest feasible placement for the demand.

    Returns a dict with ``status`` ("ok" or "infeasible"), ``segments``
    (list of {"start", "end"} ISO strings) and ``remaining_min``.
    Raises BadInput for malformed payloads.
    """
    if not isinstance(payload, dict):
        raise BadInput("request must be a JSON object")
    missing = [name for name in REQUIRED_FIELDS if name not in payload]
    if missing:
        raise BadInput("missing required field(s): " + ", ".join(missing))

    week = _parse_week(payload["week"])

    holidays_raw = payload["holidays"]
    if not isinstance(holidays_raw, (list, tuple)):
        raise BadInput("holidays must be a list of ISO 8601 dates")
    holidays = {_parse_date(item, "holidays") for item in holidays_raw}

    duration_min = _parse_duration(payload["duration_min"])

    start = _parse_dt(payload["start"], "start")
    end = _parse_dt(payload["end"], "end")
    if start >= end:
        raise BadInput("start must be earlier than end")

    busy = _parse_busy(payload["busy"], start, end)

    segments = []
    remaining = duration_min
    for seg_start, seg_end in free_intervals(start, end, week, holidays, busy):
        if remaining == 0:
            break
        usable_minutes = int((seg_end - seg_start).total_seconds() // 60)
        take = min(remaining, usable_minutes)
        if take > 0:
            segments.append({
                "start": iso(seg_start),
                "end": iso(seg_start + timedelta(minutes=take)),
            })
            remaining -= take

    return {
        "status": "ok" if remaining == 0 else "infeasible",
        "segments": segments,
        "remaining_min": remaining,
    }
