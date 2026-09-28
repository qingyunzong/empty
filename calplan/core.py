"""Core scheduling logic for calplan.

All boundaries are half-open. Time is fixed UTC and internally represented
as integer epoch minutes so that crossing midnight, holidays and busy
intervals reduce to plain interval arithmetic.
"""

from __future__ import annotations

from datetime import date, datetime, timezone

__all__ = ["BadInputError", "plan"]

_MINUTES_PER_DAY = 24 * 60
_EPOCH_DATE = date(1970, 1, 1)


class BadInputError(ValueError):
    """Raised when the request JSON is structurally or semantically invalid."""


def _epoch_day(d: date) -> int:
    return (d.toordinal() - _EPOCH_DATE.toordinal())


def _parse_iso_day(value):
    if not isinstance(value, str) or len(value) != 10:
        raise BadInputError("invalid date, expected YYYY-MM-DD")
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise BadInputError("invalid date, expected YYYY-MM-DD") from exc


def _parse_iso_minute(value, field):
    if not isinstance(value, str):
        raise BadInputError(f"{field} must be an ISO 8601 UTC datetime string")
    text = value
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise BadInputError(f"{field} is not a valid ISO 8601 datetime") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    if parsed.utcoffset() != timezone.utc.utcoffset(None):
        raise BadInputError(f"{field} must be UTC")
    if parsed.second != 0 or parsed.microsecond != 0:
        raise BadInputError(f"{field} must be aligned to whole minutes")
    return int(parsed.timestamp()) // 60


def _format_minute(total_minutes: int) -> str:
    day_index, within = divmod(total_minutes, _MINUTES_PER_DAY)
    d = date.fromordinal(_EPOCH_DATE.toordinal() + day_index)
    hour, minute = divmod(within, 60)
    return f"{d.year:04d}-{d.month:02d}-{d.day:02d}T{hour:02d}:{minute:02d}:00Z"


def _require_fields(payload):
    if not isinstance(payload, dict):
        raise BadInputError("request body must be a JSON object")
    missing = [
        name
        for name in ("week", "holidays", "busy", "duration_min", "start", "end")
        if name not in payload
    ]
    if missing:
        raise BadInputError("missing required field(s): " + ", ".join(missing))
    return payload


def _parse_week(value):
    if not isinstance(value, list) or not value:
        raise BadInputError("week must be a non-empty array of ISO weekdays 1..7")
    week = set()
    for item in value:
        if isinstance(item, bool) or not isinstance(item, int):
            raise BadInputError("week entries must be integers 1..7")
        if item < 1 or item > 7:
            raise BadInputError("week entries must be in range 1..7 (Mon=1, Sun=7)")
        week.add(item)
    return week


def _parse_duration(value):
    if isinstance(value, bool) or not isinstance(value, int):
        raise BadInputError("duration_min must be a non-negative integer")
    if value < 0:
        raise BadInputError("duration_min must be non-negative")
    return value


def _parse_holidays(value):
    if not isinstance(value, list):
        raise BadInputError("holidays must be an array of YYYY-MM-DD strings")
    holidays = set()
    for item in value:
        holidays.add(_parse_iso_day(item))
    return holidays


def _parse_busy(value):
    if not isinstance(value, list):
        raise BadInputError("busy must be an array of [start, end) intervals")
    intervals = []
    for item in value:
        if not isinstance(item, list) or len(item) != 2:
            raise BadInputError("each busy entry must be a [start, end) pair")
        start = _parse_iso_minute(item[0], "busy start")
        end = _parse_iso_minute(item[1], "busy end")
        if start > end:
            raise BadInputError("busy start must be <= busy end")
        if start < end:
            intervals.append((start, end))
    return intervals


def _merge(intervals):
    if not intervals:
        return []
    ordered = sorted(intervals, key=lambda pair: (pair[0], pair[1]))
    merged = [list(ordered[0])]
    for start, end in ordered[1:]:
        if start <= merged[-1][1]:
            if end > merged[-1][1]:
                merged[-1][1] = end
        else:
            merged.append([start, end])
    return [(start, end) for start, end in merged]


def _working_day_blocks(week, holidays, window_start, window_end):
    first_day = datetime.fromtimestamp(window_start * 60, timezone.utc).date()
    last_day = datetime.fromtimestamp((window_end - 1) * 60, timezone.utc).date()
    first_day_index = _epoch_day(first_day)
    last_day_index = _epoch_day(last_day)
    blocks = []
    for day_index in range(first_day_index, last_day_index + 1):
        d = date.fromordinal(_EPOCH_DATE.toordinal() + day_index)
        if d.isoweekday() in week and d not in holidays:
            start = day_index * _MINUTES_PER_DAY
            blocks.append((start, start + _MINUTES_PER_DAY))
    return blocks


def _clip_to_window(intervals, window_start, window_end):
    return [
        (max(start, window_start), min(end, window_end))
        for start, end in intervals
        if end > window_start and start < window_end
    ]


def _subtract(available, blocked):
    result = []
    for a_start, a_end in available:
        cursor = a_start
        for b_start, b_end in blocked:
            if b_end <= cursor:
                continue
            if b_start >= a_end:
                break
            if b_start > cursor:
                result.append((cursor, b_start))
            cursor = max(cursor, b_end)
        if cursor < a_end:
            result.append((cursor, a_end))
    return result


def plan(payload):
    """Plan the earliest contiguous segments satisfying the request.

    Returns a result dict with ``status`` (``feasible`` or ``infeasible``),
    ``segments`` (earliest half-open intervals first) and
    ``remaining_minutes``.
    """
    data = _require_fields(payload)
    week = _parse_week(data["week"])
    holidays = _parse_holidays(data["holidays"])
    busy = _parse_busy(data["busy"])
    duration = _parse_duration(data["duration_min"])
    window_start = _parse_iso_minute(data["start"], "start")
    window_end = _parse_iso_minute(data["end"], "end")
    if window_start >= window_end:
        raise BadInputError("candidate window must satisfy start < end")

    blocked_busy = _merge(_clip_to_window(busy, window_start, window_end))
    working = _clip_to_window(
        _working_day_blocks(week, holidays, window_start, window_end),
        window_start,
        window_end,
    )
    free = _merge(_subtract(working, blocked_busy))

    segments = []
    remaining = duration
    for start, end in free:
        if remaining == 0:
            break
        take = min(remaining, end - start)
        if take > 0:
            segments.append([start, start + take])
            remaining -= take

    status = "feasible" if remaining == 0 else "infeasible"
    return {
        "status": status,
        "segments": [
            {"start": _format_minute(start), "end": _format_minute(end)}
            for start, end in segments
        ],
        "remaining_minutes": remaining,
    }
