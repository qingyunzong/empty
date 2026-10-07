"""Quota windows.

Two families:

* ``CalendarWindow`` -- buckets aligned to local calendar boundaries
  (hour / business-day / week / month) in a named timezone.  Bucket keys
  come from the local wall clock via ``zoneinfo``; a business day is the
  local date, so DST transitions are handled by construction and never by
  adding a fixed 86400 seconds.
* ``RollingWindow`` -- a trailing duration evaluated at real time points.
  Admission checks every point where occupancy can increase, so
  out-of-order execution times cannot smuggle usage past the capacity.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from .timeutil import fmt_ts

CALENDAR_GRAINS = ("hour", "day", "week", "month")


@dataclass
class UsageEntry:
    hold_id: str
    version: int
    amount: int
    at: datetime  # attribution instant (UTC), i.e. the request execution time

    def to_dict(self) -> dict:
        return {
            "hold_id": self.hold_id,
            "version": self.version,
            "amount": self.amount,
            "at": fmt_ts(self.at),
        }


def _occupants(entries) -> list[dict]:
    return [e.to_dict() for e in sorted(entries, key=lambda e: (e.at, e.hold_id))]


class WindowBase:
    kind = "base"

    def __init__(self, window_id: str, capacity: int):
        if capacity < 0:
            raise ValueError("capacity must be >= 0")
        self.window_id = window_id
        self.capacity = capacity

    # -- interface -----------------------------------------------------
    def check(self, entry: UsageEntry):
        """Return a violation dict (with occupancy evidence) or None."""
        raise NotImplementedError

    def add(self, entry: UsageEntry) -> None:
        raise NotImplementedError

    def remove(self, hold_id: str, version: int) -> int:
        """Remove one hold's entry; return the amount released (0 if none)."""
        raise NotImplementedError

    def all_entries(self) -> list[UsageEntry]:
        raise NotImplementedError

    def describe(self) -> dict:
        raise NotImplementedError

    def set_capacity(self, capacity: int) -> None:
        if capacity < 0:
            raise ValueError("capacity must be >= 0")
        self.capacity = capacity


class CalendarWindow(WindowBase):
    kind = "calendar"

    def __init__(self, window_id: str, capacity: int, grain: str, tz, tz_alias: str):
        super().__init__(window_id, capacity)
        if grain not in CALENDAR_GRAINS:
            raise ValueError(f"bad calendar grain: {grain!r}")
        self.grain = grain
        self.tz = tz
        self.tz_alias = tz_alias
        self._buckets: dict[tuple, list[UsageEntry]] = {}

    def bucket_key(self, at: datetime) -> tuple:
        local = at.astimezone(self.tz)
        if self.grain == "hour":
            return (local.year, local.month, local.day, local.hour)
        if self.grain == "day":
            return (local.year, local.month, local.day)
        if self.grain == "week":
            iso = local.isocalendar()
            return (iso.year, iso.week)
        return (local.year, local.month)

    def check(self, entry: UsageEntry):
        key = self.bucket_key(entry.at)
        entries = self._buckets.get(key, [])
        used = sum(e.amount for e in entries)
        if used + entry.amount > self.capacity:
            return {
                "window": self.window_id,
                "kind": self.kind,
                "grain": self.grain,
                "tz": self.tz_alias,
                "bucket": list(key),
                "capacity": self.capacity,
                "used": used,
                "requested": entry.amount,
                "occupants": _occupants(entries),
            }
        return None

    def add(self, entry: UsageEntry) -> None:
        self._buckets.setdefault(self.bucket_key(entry.at), []).append(entry)

    def remove(self, hold_id: str, version: int) -> int:
        for key in list(self._buckets):
            entries = self._buckets[key]
            for i, e in enumerate(entries):
                if e.hold_id == hold_id and e.version == version:
                    entries.pop(i)
                    if not entries:
                        del self._buckets[key]
                    return e.amount
        return 0

    def all_entries(self) -> list[UsageEntry]:
        return [e for entries in self._buckets.values() for e in entries]

    def describe(self) -> dict:
        return {
            "window": self.window_id,
            "kind": self.kind,
            "grain": self.grain,
            "tz": self.tz_alias,
            "capacity": self.capacity,
        }


class RollingWindow(WindowBase):
    kind = "rolling"

    def __init__(self, window_id: str, capacity: int, duration: timedelta):
        super().__init__(window_id, capacity)
        if duration.total_seconds() <= 0:
            raise ValueError("rolling window duration must be positive")
        self.duration = duration
        self._entries: list[UsageEntry] = []

    def _usage_at(self, at: datetime, entries) -> int:
        lo = at - self.duration
        return sum(e.amount for e in entries if lo < e.at <= at)

    def check(self, entry: UsageEntry):
        candidate = self._entries + [entry]
        # Occupancy only ever increases exactly at an entry's instant, so
        # checking the new entry's instant plus every existing entry inside
        # the forward span covers every point that could overflow.
        checkpoints = [entry.at]
        checkpoints += [
            e.at for e in self._entries if entry.at < e.at <= entry.at + self.duration
        ]
        for point in sorted(set(checkpoints)):
            lo = point - self.duration
            members = [e for e in candidate if lo < e.at <= point]
            used = sum(e.amount for e in members)
            if used > self.capacity:
                return {
                    "window": self.window_id,
                    "kind": self.kind,
                    "duration_seconds": self.duration.total_seconds(),
                    "at": fmt_ts(point),
                    "capacity": self.capacity,
                    "used": used,
                    "requested": entry.amount,
                    "occupants": _occupants(members),
                }
        return None

    def add(self, entry: UsageEntry) -> None:
        self._entries.append(entry)

    def remove(self, hold_id: str, version: int) -> int:
        for i, e in enumerate(self._entries):
            if e.hold_id == hold_id and e.version == version:
                self._entries.pop(i)
                return e.amount
        return 0

    def all_entries(self) -> list[UsageEntry]:
        return list(self._entries)

    def describe(self) -> dict:
        return {
            "window": self.window_id,
            "kind": self.kind,
            "duration_seconds": self.duration.total_seconds(),
            "capacity": self.capacity,
        }
