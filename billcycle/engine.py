"""Expansion engine: turns a Rule into UTC-sorted, deduplicated
occurrences with a step-by-step justification for every adjustment,
plus cursor-based forward/reverse pagination.
"""
from __future__ import annotations

import base64
import json
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from . import tztable
from .calendar import ADJUST_NONE, BusinessCalendar
from .rule import DAY_LAST, DAY_LAST_BUSINESS, ANCHOR_ORIGINAL, Rule

MAX_CYCLES = 20000  # safety bound on generated cycles per expansion


def days_in_month(year: int, month: int) -> int:
    if month == 12:
        return 31
    return (date(year, month + 1, 1) - date(year, month, 1)).days


def add_months(year: int, month: int, count: int) -> tuple[int, int]:
    """(year, month) shifted by ``count`` months (may be negative)."""
    total = year * 12 + (month - 1) + count
    new_year, new_month = divmod(total, 12)
    return new_year, new_month + 1


@dataclass
class Occurrence:
    """One expanded occurrence (post-adjustment)."""
    local_date: date          # business-adjusted local date
    utc: int                  # epoch seconds of the resolved instant
    sources: list[str]        # every source that produced this instant
    steps: list[str]          # step-by-step justification

    def to_json(self, zone: tztable.Zone) -> dict:
        local = zone.utc_to_local(self.utc)
        return {
            "date": self.local_date.isoformat(),
            "local": local.strftime("%Y-%m-%dT%H:%M:%S"),
            "utc": tztable.iso_utc(self.utc),
            "utc_epoch": self.utc,
            "sources": list(self.sources),
            "steps": list(self.steps),
        }


@dataclass
class Expansion:
    occurrences: list[Occurrence] = field(default_factory=list)
    rejected: list[dict] = field(default_factory=list)
    removed: list[dict] = field(default_factory=list)


def _raw_date(rule: Rule, cal: BusinessCalendar, year: int, month: int,
              steps: list[str]) -> date:
    """Unadjusted candidate date for the cycle covering (year, month)."""
    spec = rule.effective_day_spec()
    dim = days_in_month(year, month)
    if spec == DAY_LAST:
        steps.append(f"day spec 'last' -> {year:04d}-{month:02d}-{dim:02d} "
                     f"(last day of month)")
        return date(year, month, dim)
    if spec == DAY_LAST_BUSINESS:
        current = date(year, month, dim)
        steps.append(f"day spec 'last_business_day' starts from "
                     f"{current.isoformat()} (last day of month)")
        while not cal.is_business_day(current):
            why = cal.reason(current)
            nxt = current - timedelta(days=1)
            steps.append(f"{current.isoformat()} is not a business day "
                         f"({why}); stepped back to {nxt.isoformat()}")
            current = nxt
        return current
    day = int(spec)
    if day > dim:
        steps.append(
            f"day {day} does not exist in {year:04d}-{month:02d}; clamped "
            f"to {dim} for this cycle only (anchor day {day} is preserved "
            f"for later cycles, no drift)")
        day = dim
    return date(year, month, day)


def _adjust(rule: Rule, cal: BusinessCalendar, raw: date,
            steps: list[str]) -> date:
    if rule.adjust == ADJUST_NONE or cal.is_business_day(raw):
        if rule.adjust != ADJUST_NONE:
            steps.append(f"{raw.isoformat()} is a business day; "
                         f"no adjustment needed")
        return raw
    adjusted, shift_steps = cal.shift(raw, rule.adjust)
    steps.append(f"business-day adjustment ({rule.adjust}):")
    steps.extend(shift_steps)
    if adjusted.month != raw.month:
        steps.append(f"adjustment crossed a month boundary: "
                     f"{raw.isoformat()} -> {adjusted.isoformat()}")
    return adjusted


def _resolve(rule: Rule, zone: tztable.Zone, adjusted: date,
             ) -> tuple[int | None, list[str]]:
    local = datetime.combine(adjusted, rule.time_of_day)
    return tztable.resolve_local(zone, local, rule.gap_policy,
                                 rule.repeat_policy)


def _cycle_window(rule: Rule, start_utc: int, end_utc: int,
                  ) -> tuple[int, int]:
    """Conservative [k_lo, k_hi] cycle-index window for a UTC range."""
    interval = rule.interval_months
    lo = (tztable.from_epoch(start_utc) - timedelta(days=3)).date()
    hi = (tztable.from_epoch(end_utc) + timedelta(days=3)).date()
    anchor_mi = rule.anchor.year * 12 + (rule.anchor.month - 1)
    lo_mi = lo.year * 12 + (lo.month - 1)
    hi_mi = hi.year * 12 + (hi.month - 1)
    k_lo = max(0, (lo_mi - anchor_mi) // interval - 1)
    k_hi = (hi_mi - anchor_mi) // interval + 2
    if k_hi - k_lo > MAX_CYCLES:
        raise ValueError("expansion range too large")
    return k_lo, k_hi


def expand(rule: Rule, cal: BusinessCalendar, zone: tztable.Zone,
           start_utc: int, end_utc: int) -> Expansion:
    """Expand ``rule`` over the half-open UTC range [start_utc, end_utc).

    The result is sorted by UTC and deduplicated; when several sources
    produce the same instant they are merged and every source is kept.
    """
    if end_utc <= start_utc:
        raise ValueError("end_utc must be after start_utc")
    result = Expansion()
    by_utc: dict[int, Occurrence] = {}
    remove = set(rule.remove_dates)

    def emit(adjusted: date, source: str, steps: list[str]) -> None:
        utc, tz_steps = _resolve(rule, zone, adjusted)
        steps.extend(tz_steps)
        if utc is None:
            result.rejected.append({
                "date": adjusted.isoformat(),
                "source": source,
                "reason": tz_steps[-1] if tz_steps else "rejected",
                "steps": list(steps),
            })
            return
        if not (start_utc <= utc < end_utc):
            return
        existing = by_utc.get(utc)
        if existing is None:
            by_utc[utc] = Occurrence(adjusted, utc, [source], list(steps))
        else:
            existing.sources.append(source)
            existing.steps.append(
                f"instant also produced by {source}; merged into one "
                f"occurrence (sources: {', '.join(existing.sources)})")

    # --- recurrence cycles -------------------------------------------------
    if rule.anchor_mode == ANCHOR_ORIGINAL:
        k_lo, k_hi = _cycle_window(rule, start_utc, end_utc)
        for k in range(k_lo, k_hi + 1):
            year, month = add_months(rule.anchor.year, rule.anchor.month,
                                     k * rule.interval_months)
            steps = [f"cycle {k}: anchor {rule.anchor.isoformat()} + "
                     f"{k * rule.interval_months} month(s) "
                     f"(anchor_mode=original)"]
            raw = _raw_date(rule, cal, year, month, steps)
            steps.append(f"raw candidate date: {raw.isoformat()}")
            adjusted = _adjust(rule, cal, raw, steps)
            if raw in remove:
                steps.append(f"cycle removed by exception "
                             f"(remove_dates contains {raw.isoformat()})")
                result.removed.append({"date": raw.isoformat(),
                                       "source": f"recurrence[cycle={k}]",
                                       "steps": list(steps)})
                continue
            emit(adjusted, f"recurrence[cycle={k}]", steps)
    else:  # rolling: each cycle starts from the last *adjusted* date
        interval = rule.interval_months
        hi_limit = (tztable.from_epoch(end_utc) + timedelta(days=62)).date()
        prev_adjusted: date | None = None
        k = 0
        while k <= MAX_CYCLES:
            steps = []
            if k == 0:
                year, month = rule.anchor.year, rule.anchor.month
                steps.append(f"cycle 0: anchor {rule.anchor.isoformat()} "
                             f"(anchor_mode=rolling)")
                raw = _raw_date(rule, cal, year, month, steps)
            else:
                year, month = add_months(prev_adjusted.year,
                                         prev_adjusted.month, interval)
                spec = rule.effective_day_spec()
                if spec in (DAY_LAST, DAY_LAST_BUSINESS):
                    raw = _raw_date(rule, cal, year, month, steps)
                else:
                    dim = days_in_month(year, month)
                    day = min(prev_adjusted.day, dim)
                    steps.append(
                        f"cycle {k}: rolling from previous adjusted date "
                        f"{prev_adjusted.isoformat()} + {interval} "
                        f"month(s); day {prev_adjusted.day} clamped to "
                        f"{day} in {year:04d}-{month:02d}")
                    raw = date(year, month, day)
            steps.append(f"raw candidate date: {raw.isoformat()}")
            adjusted = _adjust(rule, cal, raw, steps)
            prev_adjusted = adjusted
            if date(year, month, 1) > hi_limit and k > 0:
                break
            if raw in remove:
                steps.append(f"cycle removed by exception "
                             f"(remove_dates contains {raw.isoformat()})")
                result.removed.append({"date": raw.isoformat(),
                                       "source": f"recurrence[cycle={k}]",
                                       "steps": list(steps)})
            else:
                emit(adjusted, f"recurrence[cycle={k}]", steps)
            k += 1

    # --- explicit additions -------------------------------------------------
    for extra in sorted(set(rule.add_dates)):
        steps = [f"date {extra.isoformat()} added by exception "
                 f"(add_dates); taken as-is, no business-day adjustment"]
        emit(extra, "exception_add", steps)

    result.occurrences = sorted(by_utc.values(),
                                key=lambda occ: (occ.utc, occ.local_date))
    return result


# ---------------------------------------------------------------------------
# Cursor-based pagination
# ---------------------------------------------------------------------------

CURSOR_VERSION = 1


class CursorMismatch(Exception):
    """Raised when a cursor does not match the current rule/range."""


def _cursor_payload(rule: Rule, direction: str, last_utc: int,
                    start_utc: int, end_utc: int) -> dict:
    return {
        "v": CURSOR_VERSION,
        "anchor": rule.anchor.isoformat(),
        "rule_version": rule.version,
        "exc_hash": rule.exception_hash(),
        "dir": direction,
        "last_utc": last_utc,
        "start_utc": start_utc,
        "end_utc": end_utc,
    }


def encode_cursor(rule: Rule, direction: str, last_utc: int,
                  start_utc: int, end_utc: int) -> str:
    payload = _cursor_payload(rule, direction, last_utc, start_utc, end_utc)
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return base64.urlsafe_b64encode(blob.encode()).decode()


def decode_cursor(rule: Rule, token: str,
                  start_utc: int, end_utc: int) -> dict:
    """Validate a cursor against the current rule and range.

    A cursor minted under an older rule version or a different
    exception set is rejected, so stale cursors can never leak old
    results into a new rule version.
    """
    try:
        payload = json.loads(base64.urlsafe_b64decode(token.encode()))
    except Exception as exc:
        raise CursorMismatch(f"undecodable cursor: {exc}") from None
    expected = _cursor_payload(rule, payload.get("dir", "fwd"),
                               payload.get("last_utc", 0), start_utc, end_utc)
    for key in ("v", "anchor", "rule_version", "exc_hash",
                "start_utc", "end_utc"):
        if payload.get(key) != expected[key]:
            raise CursorMismatch(
                f"cursor field {key!r} does not match the current rule "
                f"or range (cursor={payload.get(key)!r}, "
                f"expected={expected[key]!r}); mint a fresh cursor")
    if payload.get("dir") not in ("fwd", "rev"):
        raise CursorMismatch("cursor has invalid direction")
    return payload


@dataclass
class Page:
    occurrences: list[Occurrence]
    rejected: list[dict]
    removed: list[dict]
    next_cursor: str | None
    has_more: bool
    direction: str


def paginate(rule: Rule, cal: BusinessCalendar, zone: tztable.Zone,
             start_utc: int, end_utc: int, *, page_size: int = 50,
             cursor: str | None = None, reverse: bool = False) -> Page:
    """One page of occurrences.

    Forward pages are ascending by UTC, reverse pages descending.  The
    cursor carries the original anchor, the rule version and the
    exception-set hash; any mismatch raises :class:`CursorMismatch`.
    """
    if page_size < 1:
        raise ValueError("page_size must be >= 1")
    direction = "rev" if reverse else "fwd"
    last_utc = None
    if cursor is not None:
        payload = decode_cursor(rule, cursor, start_utc, end_utc)
        direction = payload["dir"]
        last_utc = payload["last_utc"]

    expansion = expand(rule, cal, zone, start_utc, end_utc)
    items = expansion.occurrences
    if direction == "fwd":
        remaining = [o for o in items if last_utc is None or o.utc > last_utc]
        page = remaining[:page_size]
    else:
        remaining = [o for o in items if last_utc is None or o.utc < last_utc]
        page = list(reversed(remaining[-page_size:]))

    has_more = len(remaining) > len(page)
    next_cursor = None
    if has_more and page:
        next_cursor = encode_cursor(rule, direction, page[-1].utc,
                                    start_utc, end_utc)
    return Page(page, expansion.rejected, expansion.removed,
                next_cursor, has_more, direction)
