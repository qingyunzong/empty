"""Offline timezone conversion tables.

A TzTable is a frozen list of UTC transition instants.  It is fully
self-contained (no system tzdata is consulted), so conversions are
deterministic and reproducible offline.

Local -> UTC resolution explicitly handles the two DST edge cases:

* overlap (repeated local time): the caller must pick "first" or "second".
* gap (nonexistent local time): the caller must pick "reject" (the
  occurrence is dropped and reported) or "next_valid" (scan forward for
  the first local time that exists).
"""

from __future__ import annotations

import bisect
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

EPOCH = datetime(1970, 1, 1)


def naive_to_epoch(ndt: datetime) -> int:
    """Interpret a naive local datetime as a plain count of seconds."""
    return int((ndt - EPOCH).total_seconds())


def epoch_to_utc(ts: int) -> datetime:
    return datetime.fromtimestamp(ts, tz=timezone.utc)


def iso_utc(ts: int) -> str:
    return epoch_to_utc(ts).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass(frozen=True)
class Transition:
    utc_start: int  # epoch seconds when this period begins
    offset: int     # seconds east of UTC
    name: str       # abbreviation, informational only


@dataclass(frozen=True)
class ResolveResult:
    utc_ts: int | None      # None when rejected by the gap policy
    steps: tuple[str, ...]  # human-readable justification


class TzTable:
    def __init__(self, name: str, transitions: list[Transition]):
        if not transitions:
            raise ValueError("a table needs at least one transition")
        transitions = sorted(transitions, key=lambda t: t.utc_start)
        self.name = name
        self.transitions = transitions
        self._starts = [t.utc_start for t in transitions]
        self.offsets = sorted({t.offset for t in transitions})

    def offset_at(self, utc_ts: int) -> int:
        i = bisect.bisect_right(self._starts, utc_ts) - 1
        if i < 0:
            i = 0
        return self.transitions[i].offset

    def local_bounds_for_utc_window(self, start_ts: int, end_ts: int) -> tuple[int, int]:
        """Naive-local epoch bounds that may map into [start_ts, end_ts)."""
        big = max(abs(o) for o in self.offsets) + 86400
        return start_ts - big, end_ts + big

    def resolve(self, local: datetime, gap: str = "reject",
                overlap: str = "first") -> ResolveResult:
        if gap not in ("reject", "next_valid"):
            raise ValueError(f"bad gap policy: {gap}")
        if overlap not in ("first", "second"):
            raise ValueError(f"bad overlap policy: {overlap}")
        steps: list[str] = []
        le = naive_to_epoch(local)
        candidates: dict[int, int] = {}
        for off in self.offsets:
            guess = le - off
            if self.offset_at(guess) == off:
                candidates[guess] = off
        if len(candidates) == 1:
            utc_ts = next(iter(candidates))
            steps.append(
                f"tz[{self.name}]: local {local:%Y-%m-%d %H:%M} maps to "
                f"{iso_utc(utc_ts)} (offset {candidates[utc_ts] // 60:+d}min)")
            return ResolveResult(utc_ts, tuple(steps))
        if len(candidates) > 1:
            ordered = sorted(candidates)
            pick = ordered[0] if overlap == "first" else ordered[-1]
            steps.append(
                f"tz[{self.name}]: local {local:%Y-%m-%d %H:%M} occurs "
                f"{len(ordered)} times (DST overlap); policy={overlap} selects "
                f"{iso_utc(pick)}")
            return ResolveResult(pick, tuple(steps))
        # No candidate: the local time never happens (DST gap).
        if gap == "reject":
            steps.append(
                f"tz[{self.name}]: local {local:%Y-%m-%d %H:%M} does not exist "
                f"(DST gap); policy=reject -> occurrence dropped")
            return ResolveResult(None, tuple(steps))
        probe = local
        for _ in range(24 * 60):
            probe += timedelta(minutes=1)
            pe = naive_to_epoch(probe)
            for off in self.offsets:
                guess = pe - off
                if self.offset_at(guess) == off:
                    steps.append(
                        f"tz[{self.name}]: local {local:%Y-%m-%d %H:%M} does "
                        f"not exist (DST gap); policy=next_valid -> "
                        f"{probe:%Y-%m-%d %H:%M} -> {iso_utc(guess)}")
                    return ResolveResult(guess, tuple(steps))
        raise ValueError(f"no valid local time within 24h of {local}")


def _nth_weekday_of_month(year: int, month: int, weekday: int, n: int) -> datetime:
    d = datetime(year, month, 1)
    delta = (weekday - d.weekday()) % 7
    return d + timedelta(days=delta + 7 * (n - 1))


def new_york_table(first_year: int = 2000, last_year: int = 2040) -> TzTable:
    """America/New_York per the post-2007 US DST rule, frozen as data."""
    est, edt = -5 * 3600, -4 * 3600
    transitions = [Transition(0, est, "EST")]
    for year in range(first_year, last_year + 1):
        start_local = _nth_weekday_of_month(year, 3, 6, 2).replace(hour=2)
        end_local = _nth_weekday_of_month(year, 11, 6, 1).replace(hour=2)
        transitions.append(Transition(naive_to_epoch(start_local) - est, edt, "EDT"))
        transitions.append(Transition(naive_to_epoch(end_local) - edt, est, "EST"))
    return TzTable("America/New_York", transitions)


def fixed_table(name: str, offset_seconds: int, abbrev: str) -> TzTable:
    return TzTable(name, [Transition(-2**62, offset_seconds, abbrev)])


def utc_table() -> TzTable:
    return fixed_table("UTC", 0, "UTC")


def load_table_json(path: str) -> TzTable:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    return TzTable(data["name"], [
        Transition(int(t["utc_start"]), int(t["offset"]), str(t.get("name", "")))
        for t in data["transitions"]
    ])


_REGISTRY: dict[str, TzTable] | None = None


def get_table(name: str) -> TzTable:
    global _REGISTRY
    if _REGISTRY is None:
        _REGISTRY = {
            "UTC": utc_table(),
            "Asia/Shanghai": fixed_table("Asia/Shanghai", 8 * 3600, "CST"),
            "America/New_York": new_york_table(),
        }
    try:
        return _REGISTRY[name]
    except KeyError:
        raise KeyError(f"unknown offline tz table: {name!r}; "
                       f"available: {sorted(_REGISTRY)}") from None


def table_names() -> list[str]:
    get_table("UTC")
    return sorted(_REGISTRY or {})
