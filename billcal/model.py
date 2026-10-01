"""Recurrence rule model.

A Rule is immutable; any change must bump ``version``.  Cursors embed the
version and the exception-set hash so results from different rule versions
can never be mixed.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field, replace
from datetime import date, datetime, time

ADJUST_MODES = ("none", "following", "preceding")
ANCHOR_MODES = ("original", "adjusted")
DAY_SPECS = ("day_of_month", "last_business_day")


def _parse_date(s: str) -> date:
    return date.fromisoformat(s)


def _parse_local(s: str) -> datetime:
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is not None:
        raise ValueError("local datetimes must be naive: " + s)
    return dt


@dataclass(frozen=True)
class Rule:
    anchor: date
    time_of_day: time = time(9, 0)
    interval_months: int = 1
    day_spec: str = "day_of_month"        # or "last_business_day"
    day: int | None = None                # day of month; default anchor.day
    adjust: str = "none"                  # none | following | preceding
    anchor_mode: str = "original"         # original | adjusted
    holidays: frozenset[date] = field(default_factory=frozenset)
    weekend: tuple[int, ...] = (5, 6)     # Saturday, Sunday
    exceptions_add: frozenset[datetime] = field(default_factory=frozenset)
    exceptions_remove: frozenset[date] = field(default_factory=frozenset)
    tz: str = "UTC"
    gap_policy: str = "reject"            # reject | next_valid
    overlap_policy: str = "first"         # first | second
    version: int = 1

    def __post_init__(self):
        if self.interval_months < 1:
            raise ValueError("interval_months must be >= 1")
        if self.day_spec not in DAY_SPECS:
            raise ValueError(f"day_spec must be one of {DAY_SPECS}")
        if self.adjust not in ADJUST_MODES:
            raise ValueError(f"adjust must be one of {ADJUST_MODES}")
        if self.anchor_mode not in ANCHOR_MODES:
            raise ValueError(f"anchor_mode must be one of {ANCHOR_MODES}")
        if self.day_spec == "day_of_month":
            day = self.day if self.day is not None else self.anchor.day
            if not 1 <= day <= 31:
                raise ValueError("day must be in 1..31")
            object.__setattr__(self, "day", day)

    @property
    def exceptions_hash(self) -> str:
        payload = json.dumps({
            "add": sorted(d.isoformat() for d in self.exceptions_add),
            "remove": sorted(d.isoformat() for d in self.exceptions_remove),
        }, sort_keys=True)
        return hashlib.sha256(payload.encode()).hexdigest()[:16]

    def with_changes(self, **kw) -> "Rule":
        """Return a modified copy; the caller is expected to bump version."""
        return replace(self, **kw)

    def to_dict(self) -> dict:
        return {
            "anchor": self.anchor.isoformat(),
            "time_of_day": self.time_of_day.strftime("%H:%M"),
            "interval_months": self.interval_months,
            "day_spec": self.day_spec,
            "day": self.day,
            "adjust": self.adjust,
            "anchor_mode": self.anchor_mode,
            "holidays": sorted(d.isoformat() for d in self.holidays),
            "weekend": list(self.weekend),
            "exceptions_add": sorted(d.isoformat() for d in self.exceptions_add),
            "exceptions_remove": sorted(d.isoformat() for d in self.exceptions_remove),
            "tz": self.tz,
            "gap_policy": self.gap_policy,
            "overlap_policy": self.overlap_policy,
            "version": self.version,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Rule":
        hh, mm = (int(x) for x in data.get("time_of_day", "09:00").split(":"))
        return cls(
            anchor=_parse_date(data["anchor"]),
            time_of_day=time(hh, mm),
            interval_months=int(data.get("interval_months", 1)),
            day_spec=data.get("day_spec", "day_of_month"),
            day=data.get("day"),
            adjust=data.get("adjust", "none"),
            anchor_mode=data.get("anchor_mode", "original"),
            holidays=frozenset(_parse_date(d) for d in data.get("holidays", [])),
            weekend=tuple(data.get("weekend", (5, 6))),
            exceptions_add=frozenset(_parse_local(d) for d in data.get("exceptions_add", [])),
            exceptions_remove=frozenset(_parse_date(d) for d in data.get("exceptions_remove", [])),
            tz=data.get("tz", "UTC"),
            gap_policy=data.get("gap_policy", "reject"),
            overlap_policy=data.get("overlap_policy", "first"),
            version=int(data.get("version", 1)),
        )
