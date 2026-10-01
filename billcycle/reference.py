"""Independent reference implementation: plain day-by-day enumeration.

This module deliberately shares no logic with :mod:`billcycle.engine`
beyond the Rule/Calendar data types.  It walks month-by-month from the
anchor (advancing one month at a time in a loop) and steps day-by-day
for adjustments, so it can be used to cross-check the main engine over
finite year ranges.  Only ``anchor_mode=original`` is supported.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta

from .calendar import ADJUST_NONE, FOLLOWING, BusinessCalendar
from .rule import ANCHOR_ORIGINAL, DAY_LAST, DAY_LAST_BUSINESS, Rule


def _days_in_month(year: int, month: int) -> int:
    if month == 12:
        return 31
    return (date(year, month + 1, 1) - date(year, month, 1)).days


def enumerate_dates(rule: Rule, cal: BusinessCalendar,
                    start: date, end: date) -> list[date]:
    """All occurrence dates in [start, end] by brute-force walking."""
    if rule.anchor_mode != ANCHOR_ORIGINAL:
        raise ValueError("reference implementation supports "
                         "anchor_mode=original only")
    found: list[date] = []
    remove = set(rule.remove_dates)
    year, month = rule.anchor.year, rule.anchor.month
    guard = 0
    while date(year, month, 1) <= end and guard < 20000:
        guard += 1
        spec = rule.effective_day_spec()
        dim = _days_in_month(year, month)
        if spec == DAY_LAST:
            raw = date(year, month, dim)
        elif spec == DAY_LAST_BUSINESS:
            raw = date(year, month, dim)
            while not cal.is_business_day(raw):
                raw -= timedelta(days=1)
        else:
            raw = date(year, month, min(int(spec), dim))
        adjusted = raw
        if rule.adjust != ADJUST_NONE:
            step = timedelta(days=1 if rule.adjust == FOLLOWING else -1)
            while not cal.is_business_day(adjusted):
                adjusted += step
        if raw not in remove and start <= adjusted <= end:
            found.append(adjusted)
        # advance interval months, one month at a time
        for _ in range(rule.interval_months):
            month += 1
            if month == 13:
                month = 1
                year += 1
    for extra in rule.add_dates:
        if start <= extra <= end:
            found.append(extra)
    return sorted(set(found))


def cross_check(rule: Rule, cal: BusinessCalendar, zone,
                start: date, end: date) -> dict:
    """Compare the engine against the reference over [start, end].

    The engine runs over a padded UTC range; only occurrences whose
    local date falls inside [start, end] are compared.
    """
    from . import engine, tztable  # local import: keep modules independent

    start_utc = tztable.to_epoch(datetime.combine(start, datetime.min.time())
                                 - timedelta(days=2))
    end_utc = tztable.to_epoch(datetime.combine(end, datetime.min.time())
                               + timedelta(days=2))
    expansion = engine.expand(rule, cal, zone, start_utc, end_utc)
    engine_dates = sorted({o.local_date for o in expansion.occurrences
                           if start <= o.local_date <= end})
    ref_dates = enumerate_dates(rule, cal, start, end)
    only_engine = sorted(set(engine_dates) - set(ref_dates))
    only_ref = sorted(set(ref_dates) - set(engine_dates))
    return {
        "ok": not only_engine and not only_ref,
        "engine_count": len(engine_dates),
        "reference_count": len(ref_dates),
        "only_engine": [d.isoformat() for d in only_engine],
        "only_reference": [d.isoformat() for d in only_ref],
    }
