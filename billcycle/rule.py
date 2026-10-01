"""Recurrence rule definition, validation, versioning and JSON codec."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field, replace
from datetime import date, time

from . import tztable
from .calendar import ADJUST_POLICIES, FOLLOWING

DAY_LAST = "last"
DAY_LAST_BUSINESS = "last_business_day"
DAY_SPECS = (DAY_LAST, DAY_LAST_BUSINESS)

ANCHOR_ORIGINAL = "original"  # every cycle is computed from the anchor day
ANCHOR_ROLLING = "rolling"    # every cycle starts from the last adjusted day
ANCHOR_MODES = (ANCHOR_ORIGINAL, ANCHOR_ROLLING)


@dataclass(frozen=True)
class Rule:
    """A local-calendar billing recurrence.

    ``day_of_month`` is an int 1..31, ``last`` or ``last_business_day``;
    ``None`` means "the anchor's day of month".

    ``anchor_mode`` is explicit about what a cycle is anchored to:
      - ``original``: cycle k is computed from the anchor month plus
        k*interval months, clamped into short months.  Clamping never
        propagates, so short months cannot silently drift the schedule.
      - ``rolling``: cycle k+1 is computed from the *adjusted* date of
        cycle k.  This mode can drift by design; it must be requested
        explicitly.
    """

    anchor: date
    interval_months: int = 1
    day_of_month: object = None
    anchor_mode: str = ANCHOR_ORIGINAL
    adjust: str = FOLLOWING
    time_of_day: time = time(9, 0)
    zone: str = "UTC"
    gap_policy: str = tztable.GAP_SHIFT_FORWARD
    repeat_policy: str = tztable.REPEAT_EARLIER
    add_dates: tuple[date, ...] = ()
    remove_dates: tuple[date, ...] = ()
    version: int = 1
    name: str = "rule"

    def __post_init__(self):
        if not isinstance(self.anchor, date):
            raise ValueError("anchor must be a date")
        if not isinstance(self.interval_months, int) or self.interval_months < 1:
            raise ValueError("interval_months must be a positive int")
        spec = self.day_of_month
        if spec is not None:
            if spec in DAY_SPECS:
                pass
            elif isinstance(spec, int) and not isinstance(spec, bool) \
                    and 1 <= spec <= 31:
                pass
            else:
                raise ValueError(
                    "day_of_month must be 1..31, 'last', "
                    f"'last_business_day' or None, got {spec!r}")
        if self.anchor_mode not in ANCHOR_MODES:
            raise ValueError(f"anchor_mode must be one of {ANCHOR_MODES}")
        if self.adjust not in ADJUST_POLICIES:
            raise ValueError(f"adjust must be one of {ADJUST_POLICIES}")
        if self.gap_policy not in tztable.GAP_POLICIES:
            raise ValueError(f"gap_policy must be one of {tztable.GAP_POLICIES}")
        if self.repeat_policy not in tztable.REPEAT_POLICIES:
            raise ValueError(
                f"repeat_policy must be one of {tztable.REPEAT_POLICIES}")
        if not isinstance(self.time_of_day, time):
            raise ValueError("time_of_day must be a datetime.time")
        tztable.get_zone(self.zone)  # raises for unknown zones
        if self.version < 1:
            raise ValueError("version must be >= 1")
        overlap = set(self.add_dates) & set(self.remove_dates)
        if overlap:
            raise ValueError(
                f"dates in both add_dates and remove_dates: "
                f"{sorted(d.isoformat() for d in overlap)}")

    def effective_day_spec(self):
        """The day specifier actually used for cycle computation."""
        return self.day_of_month if self.day_of_month is not None \
            else self.anchor.day

    def exception_hash(self) -> str:
        """Stable hash of the exception set (add + remove dates)."""
        canonical = json.dumps(
            {"add": sorted(d.isoformat() for d in self.add_dates),
             "remove": sorted(d.isoformat() for d in self.remove_dates)},
            sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode()).hexdigest()[:16]

    def updated(self, **changes) -> "Rule":
        """Return a modified copy with the version bumped by one."""
        if "version" in changes:
            raise ValueError("version is managed automatically")
        return replace(self, **changes, version=self.version + 1)

    # -- JSON codec ---------------------------------------------------------

    def to_json(self) -> dict:
        spec = self.day_of_month
        return {
            "name": self.name,
            "anchor": self.anchor.isoformat(),
            "interval_months": self.interval_months,
            "day_of_month": spec,
            "anchor_mode": self.anchor_mode,
            "adjust": self.adjust,
            "time_of_day": self.time_of_day.strftime("%H:%M"),
            "zone": self.zone,
            "gap_policy": self.gap_policy,
            "repeat_policy": self.repeat_policy,
            "add_dates": sorted(d.isoformat() for d in self.add_dates),
            "remove_dates": sorted(d.isoformat() for d in self.remove_dates),
            "version": self.version,
        }

    @classmethod
    def from_json(cls, data: dict) -> "Rule":
        if not isinstance(data, dict):
            raise ValueError("rule JSON must be an object")
        try:
            anchor = date.fromisoformat(data["anchor"])
        except (KeyError, ValueError) as exc:
            raise ValueError(f"rule JSON has invalid anchor: {exc}") from None
        tod_raw = data.get("time_of_day", "09:00")
        try:
            hour, minute = (int(part) for part in tod_raw.split(":"))
            tod = time(hour, minute)
        except (ValueError, AttributeError):
            raise ValueError(f"invalid time_of_day: {tod_raw!r}") from None
        return cls(
            name=data.get("name", "rule"),
            anchor=anchor,
            interval_months=int(data.get("interval_months", 1)),
            day_of_month=data.get("day_of_month"),
            anchor_mode=data.get("anchor_mode", ANCHOR_ORIGINAL),
            adjust=data.get("adjust", FOLLOWING),
            time_of_day=tod,
            zone=data.get("zone", "UTC"),
            gap_policy=data.get("gap_policy", tztable.GAP_SHIFT_FORWARD),
            repeat_policy=data.get("repeat_policy", tztable.REPEAT_EARLIER),
            add_dates=tuple(date.fromisoformat(s)
                            for s in data.get("add_dates", [])),
            remove_dates=tuple(date.fromisoformat(s)
                               for s in data.get("remove_dates", [])),
            version=int(data.get("version", 1)),
        )
