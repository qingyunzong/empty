"""Business-day calendar: weekends plus an explicit holiday table."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Mapping

WEEKDAY_NAMES = ("Monday", "Tuesday", "Wednesday", "Thursday",
                 "Friday", "Saturday", "Sunday")

FOLLOWING = "following"
PRECEDING = "preceding"
ADJUST_NONE = "none"
ADJUST_POLICIES = (ADJUST_NONE, FOLLOWING, PRECEDING)


@dataclass(frozen=True)
class BusinessCalendar:
    """Which days are business days.

    ``holidays`` maps a date to a human-readable name (``""`` allowed);
    ``weekend`` holds ``date.weekday()`` numbers (default Sat/Sun).
    """

    holidays: Mapping[date, str] = field(default_factory=dict)
    weekend: tuple[int, ...] = (5, 6)

    def is_business_day(self, day: date) -> bool:
        return day.weekday() not in self.weekend and day not in self.holidays

    def reason(self, day: date) -> str:
        """Why ``day`` is not a business day (empty string if it is)."""
        parts = []
        if day.weekday() in self.weekend:
            parts.append(WEEKDAY_NAMES[day.weekday()])
        if day in self.holidays:
            name = self.holidays[day]
            parts.append(f"holiday ({name})" if name else "holiday")
        return " & ".join(parts)

    def shift(self, day: date, direction: str) -> tuple[date, list[str]]:
        """Move ``day`` to the nearest business day, logging each hop.

        ``direction`` is ``following`` (forward) or ``preceding``
        (backward).  Consecutive holidays/weekends are stepped one day
        at a time, so a holiday streak crossing a month boundary is
        fully explained in the returned steps.
        """
        if direction not in (FOLLOWING, PRECEDING):
            raise ValueError(f"unknown adjustment direction: {direction!r}")
        steps: list[str] = []
        current = day
        delta = timedelta(days=1 if direction == FOLLOWING else -1)
        while not self.is_business_day(current):
            why = self.reason(current)
            nxt = current + delta
            steps.append(
                f"{current.isoformat()} is not a business day ({why}); "
                f"moved {direction} to {nxt.isoformat()}")
            current = nxt
        return current, steps
