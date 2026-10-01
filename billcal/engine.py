"""Expansion engine: local recurrence -> UTC instants, with full trace.

Every occurrence carries ``steps``: the deterministic justification of how
its due date was computed (base month, clamping, business-day adjustment,
timezone resolution).  Occurrences dropped by exceptions or DST gaps are
reported in ``rejected`` with their reason.
"""

from __future__ import annotations

import base64
import calendar
import json
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from .model import Rule
from .tztable import TzTable, get_table, iso_utc, naive_to_epoch


class StaleCursorError(ValueError):
    """The cursor does not match the rule's anchor/version/exceptions."""


def days_in_month(year: int, month: int) -> int:
    return calendar.monthrange(year, month)[1]


def add_months(year: int, month: int, n: int) -> tuple[int, int]:
    total = year * 12 + (month - 1) + n
    return total // 12, total % 12 + 1


@dataclass(frozen=True)
class Occurrence:
    utc_ts: int
    local: datetime
    sources: tuple[str, ...]
    steps: tuple[str, ...]

    def to_dict(self) -> dict:
        return {
            "utc": iso_utc(self.utc_ts),
            "local": self.local.strftime("%Y-%m-%dT%H:%M:%S"),
            "sources": list(self.sources),
            "steps": list(self.steps),
        }


@dataclass(frozen=True)
class Rejected:
    local: datetime
    source: str
    reason: str
    steps: tuple[str, ...]

    def to_dict(self) -> dict:
        return {
            "local": self.local.strftime("%Y-%m-%dT%H:%M:%S"),
            "source": self.source,
            "reason": self.reason,
            "steps": list(self.steps),
        }


@dataclass
class Expansion:
    occurrences: list[Occurrence] = field(default_factory=list)
    rejected: list[Rejected] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "occurrences": [o.to_dict() for o in self.occurrences],
            "rejected": [r.to_dict() for r in self.rejected],
        }


def is_business_day(rule: Rule, d: date) -> bool:
    return d.weekday() not in rule.weekend and d not in rule.holidays


def _adjust_business(rule: Rule, d: date) -> tuple[date, list[str]]:
    steps: list[str] = []
    if rule.adjust == "none" or is_business_day(rule, d):
        return d, steps
    delta = 1 if rule.adjust == "following" else -1
    cur = d
    while not is_business_day(rule, cur):
        why = []
        if cur.weekday() in rule.weekend:
            why.append("weekend")
        if cur in rule.holidays:
            why.append("holiday")
        nxt = cur + timedelta(days=delta)
        steps.append(f"adjust[{rule.adjust}]: {cur} is {'+'.join(why)} -> {nxt}")
        cur = nxt
    return cur, steps


def _candidate_in_month(rule: Rule, year: int, month: int,
                        carried_day: int) -> tuple[date, list[str]]:
    steps: list[str] = []
    if rule.day_spec == "last_business_day":
        d = date(year, month, days_in_month(year, month))
        steps.append(f"base: last day of {year}-{month:02d} is {d}")
        while not is_business_day(rule, d):
            nxt = d - timedelta(days=1)
            steps.append(f"last_business_day: {d} is not a business day -> {nxt}")
            d = nxt
        return d, steps
    dim = days_in_month(year, month)
    day = min(carried_day, dim)
    if day != carried_day:
        steps.append(
            f"clamp: day {carried_day} exceeds {dim} days in "
            f"{year}-{month:02d} -> {day} (anchor day {rule.day} kept for "
            f"future months)")
    return date(year, month, day), steps


def iter_recurrence_local(rule: Rule, end_bound: date):
    """Yield (local_naive_datetime, steps) for recurrence occurrences."""
    if rule.anchor_mode == "original":
        k = 0
        while True:
            y, m = add_months(rule.anchor.year, rule.anchor.month,
                              k * rule.interval_months)
            if date(y, m, 1) > end_bound:
                break
            steps = [f"base: anchor {rule.anchor} + {k}x"
                     f"{rule.interval_months}mo -> {y}-{m:02d}"]
            d, more = _candidate_in_month(rule, y, m, rule.day)
            steps.extend(more)
            d, more = _apply_adjust(rule, d)
            steps.extend(more)
            yield datetime.combine(d, rule.time_of_day), steps
            k += 1
    else:  # adjusted: each step builds on the previous adjusted date
        prev = rule.anchor
        k = 0
        while True:
            if k == 0:
                base = rule.anchor
                steps = [f"base: anchor {rule.anchor} (adjusted mode)"]
            else:
                y, m = add_months(prev.year, prev.month, rule.interval_months)
                dim = days_in_month(y, m)
                day = min(prev.day, dim)
                base = date(y, m, day)
                note = (f"base: previous adjusted date {prev} + "
                        f"{rule.interval_months}mo -> {base} (day {prev.day} "
                        f"carried from previous adjusted date")
                note += ", clamped)" if day != prev.day else ")"
                steps = [note]
            if date(base.year, base.month, 1) > end_bound:
                break
            if rule.day_spec == "last_business_day":
                d, more = _candidate_in_month(rule, base.year, base.month, base.day)
                steps.extend(more)
            else:
                d = base
            d, more = _apply_adjust(rule, d)
            steps.extend(more)
            yield datetime.combine(d, rule.time_of_day), steps
            prev = d
            k += 1


def _apply_adjust(rule: Rule, d: date) -> tuple[date, list[str]]:
    return _adjust_business(rule, d)


def expand(rule: Rule, start_utc: int, end_utc: int,
           table: TzTable | None = None) -> Expansion:
    """Expand ``rule`` into UTC instants in [start_utc, end_utc).

    The result is sorted by UTC and deduplicated; merged occurrences keep
    every contributing source in ``sources``.
    """
    table = table or get_table(rule.tz)
    lo, hi = table.local_bounds_for_utc_window(start_utc, end_utc)
    end_bound = datetime(1970, 1, 1) + timedelta(seconds=hi)
    start_bound = datetime(1970, 1, 1) + timedelta(seconds=lo)

    merged: dict[int, dict] = {}
    rejected: list[Rejected] = []

    def absorb(utc_ts: int, local: datetime, source: str, steps: list[str]):
        slot = merged.setdefault(utc_ts, {"local": local, "sources": [], "steps": []})
        if source not in slot["sources"]:
            slot["sources"].append(source)
        slot["steps"].extend(steps)

    for local, steps in iter_recurrence_local(rule, end_bound.date()):
        if local < start_bound:
            continue
        if local.date() in rule.exceptions_remove:
            rejected.append(Rejected(
                local, "recurrence",
                f"removed by exception_remove {local.date()}",
                tuple(steps)))
            continue
        res = table.resolve(local, rule.gap_policy, rule.overlap_policy)
        steps.extend(res.steps)
        if res.utc_ts is None:
            rejected.append(Rejected(local, "recurrence",
                                     "local time does not exist (DST gap)",
                                     tuple(steps)))
            continue
        absorb(res.utc_ts, local, "recurrence", steps)

    for local in sorted(rule.exceptions_add):
        steps = [f"exception_add: extra occurrence at local {local}"]
        res = table.resolve(local, rule.gap_policy, rule.overlap_policy)
        steps.extend(res.steps)
        if res.utc_ts is None:
            rejected.append(Rejected(local, "exception_add",
                                     "local time does not exist (DST gap)",
                                     tuple(steps)))
            continue
        absorb(res.utc_ts, local, "exception_add", steps)

    occurrences = [
        Occurrence(utc_ts=ts, local=slot["local"],
                   sources=tuple(sorted(slot["sources"])),
                   steps=tuple(slot["steps"]))
        for ts, slot in sorted(merged.items())
        if start_utc <= ts < end_utc
    ]
    rejected.sort(key=lambda r: r.local)
    return Expansion(occurrences, rejected)


# ---------------------------------------------------------------- cursors

def encode_cursor(rule: Rule, last_utc_ts: int) -> str:
    payload = {
        "a": rule.anchor.isoformat(),
        "v": rule.version,
        "x": rule.exceptions_hash,
        "last": last_utc_ts,
    }
    raw = json.dumps(payload, sort_keys=True).encode()
    return base64.urlsafe_b64encode(raw).decode()


def decode_cursor(rule: Rule, token: str) -> int:
    try:
        payload = json.loads(base64.urlsafe_b64decode(token.encode()))
    except Exception as exc:
        raise StaleCursorError(f"undecodable cursor: {exc}") from exc
    problems = []
    if payload.get("a") != rule.anchor.isoformat():
        problems.append(f"anchor {payload.get('a')} != {rule.anchor}")
    if payload.get("v") != rule.version:
        problems.append(f"version {payload.get('v')} != {rule.version}")
    if payload.get("x") != rule.exceptions_hash:
        problems.append("exception set changed")
    if problems:
        raise StaleCursorError(
            "cursor does not match current rule (refusing to mix results "
            "across rule versions): " + "; ".join(problems))
    return int(payload["last"])


@dataclass
class Page:
    occurrences: list[Occurrence]
    rejected: list[Rejected]
    next_cursor: str | None
    prev_cursor: str | None

    def to_dict(self) -> dict:
        return {
            "occurrences": [o.to_dict() for o in self.occurrences],
            "rejected": [r.to_dict() for r in self.rejected],
            "next_cursor": self.next_cursor,
            "prev_cursor": self.prev_cursor,
        }


def paginate(rule: Rule, start_utc: int, end_utc: int, limit: int = 50,
             cursor: str | None = None, direction: str = "forward",
             table: TzTable | None = None) -> Page:
    if direction not in ("forward", "backward"):
        raise ValueError("direction must be 'forward' or 'backward'")
    if limit < 1:
        raise ValueError("limit must be >= 1")
    result = expand(rule, start_utc, end_utc, table)
    after = decode_cursor(rule, cursor) if cursor else None
    if direction == "forward":
        items = [o for o in result.occurrences if after is None or o.utc_ts > after]
        page, more = items[:limit], len(items) > limit
        next_cursor = encode_cursor(rule, page[-1].utc_ts) if page and more else None
        prev_cursor = encode_cursor(rule, page[0].utc_ts) if page and cursor else None
    else:
        items = [o for o in result.occurrences if after is None or o.utc_ts < after]
        page, more = items[-limit:], len(items) > limit
        prev_cursor = encode_cursor(rule, page[0].utc_ts) if page and more else None
        next_cursor = encode_cursor(rule, page[-1].utc_ts) if page and cursor else None
    return Page(page, result.rejected, next_cursor, prev_cursor)
