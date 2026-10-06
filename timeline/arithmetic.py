"""Two arithmetic regimes that must never be interchanged.

* Wall-clock arithmetic (``add_days_wallclock`` / ``add_months_wallclock``)
  operates on the calendar fields of a LocalDateTime.  It knows nothing
  about offsets; the result may land in a gap or a fold.
* Timeline arithmetic (``add_seconds_timeline``) operates on an Instant and
  a Duration of exact seconds.  It knows nothing about calendars.

Adding 1 wall-clock day across a spring-forward jump spans 82800 timeline
seconds, not 86400 -- the two regimes disagree there by design.
"""
from __future__ import annotations

from datetime import timedelta

from .core import Duration, Instant, LocalDateTime

_DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]


def _is_leap(year: int) -> bool:
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)


def add_days_wallclock(ldt: LocalDateTime, days: int) -> LocalDateTime:
    return LocalDateTime(ldt.naive + timedelta(days=days))


def add_months_wallclock(ldt: LocalDateTime, months: int) -> LocalDateTime:
    total = ldt.naive.year * 12 + (ldt.naive.month - 1) + months
    year, month0 = divmod(total, 12)
    month = month0 + 1
    last_day = _DAYS_IN_MONTH[month0]
    if month == 2 and _is_leap(year):
        last_day = 29
    day = min(ldt.naive.day, last_day)  # clamp: Jan 31 + 1mo -> Feb 28/29
    return LocalDateTime(ldt.naive.replace(year=year, month=month, day=day))


def add_seconds_timeline(instant: Instant, seconds: int) -> Instant:
    return Instant(instant.epoch_seconds + seconds)


def add_duration(instant: Instant, duration: Duration) -> Instant:
    return Instant(instant.epoch_seconds + duration.seconds)
