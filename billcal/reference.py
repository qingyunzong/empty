"""Independent reference implementation used to cross-check the engine.

Where the engine is index-driven (month offset k from the anchor), this
reference is enumeration-driven: it walks every month in the window and,
within each month, scans day by day.  The two share only the Rule model
and the TzTable; the scheduling logic is written independently on purpose
so that a bug in one is caught by the other.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

from .model import Rule
from .tztable import TzTable, get_table


def _biz(rule: Rule, d: date) -> bool:
    return d.weekday() not in rule.weekend and d not in rule.holidays


def _dim(year: int, month: int) -> int:
    if month == 12:
        nxt = date(year + 1, 1, 1)
    else:
        nxt = date(year, month + 1, 1)
    return (nxt - date(year, month, 1)).days


def reference_local_dates(rule: Rule, start_year: int, end_year: int) -> set[date]:
    """Brute-force the set of local occurrence dates in the given years."""
    out: set[date] = set()
    n = rule.interval_months

    if rule.anchor_mode == "original":
        # Walk month by month; a month is scheduled when its distance from
        # the anchor month is a non-negative multiple of n.
        y, m = rule.anchor.year, rule.anchor.month
        while y <= end_year + 1:
            if y >= start_year - 1:
                if rule.day_spec == "last_business_day":
                    d = date(y, m, _dim(y, m))
                    while not _biz(rule, d):
                        d -= timedelta(days=1)
                else:
                    d = date(y, m, min(rule.day, _dim(y, m)))
                if rule.adjust == "following":
                    while not _biz(rule, d):
                        d += timedelta(days=1)
                elif rule.adjust == "preceding":
                    while not _biz(rule, d):
                        d -= timedelta(days=1)
                out.add(d)
            m += 1
            if m == 13:
                m, y = 1, y + 1
            # skip months that are not multiples of n from the anchor
            while ((y - rule.anchor.year) * 12 + (m - rule.anchor.month)) % n != 0:
                m += 1
                if m == 13:
                    m, y = 1, y + 1
    else:
        # Adjusted mode: chain from the previous adjusted date.
        prev = rule.anchor
        guard = 0
        while prev.year <= end_year + 1 and guard < 10000:
            guard += 1
            if prev.year >= start_year - 1:
                out.add(prev)
            total = prev.year * 12 + (prev.month - 1) + n
            y, m = total // 12, total % 12 + 1
            if rule.day_spec == "last_business_day":
                d = date(y, m, _dim(y, m))
                while not _biz(rule, d):
                    d -= timedelta(days=1)
            else:
                d = date(y, m, min(prev.day, _dim(y, m)))
            if rule.adjust == "following":
                while not _biz(rule, d):
                    d += timedelta(days=1)
            elif rule.adjust == "preceding":
                while not _biz(rule, d):
                    d -= timedelta(days=1)
            prev = d

    out = {d for d in out if d not in rule.exceptions_remove}
    out |= {dt.date() for dt in rule.exceptions_add}
    return {d for d in out if start_year - 1 <= d.year <= end_year + 1}


def reference_utc_instants(rule: Rule, start_year: int, end_year: int,
                           table: TzTable | None = None) -> set[int]:
    """Resolve the reference local dates to UTC instants independently."""
    table = table or get_table(rule.tz)
    instants: set[int] = set()
    for d in reference_local_dates(rule, start_year, end_year):
        local = datetime.combine(d, rule.time_of_day)
        res = table.resolve(local, rule.gap_policy, rule.overlap_policy)
        if res.utc_ts is not None:
            instants.add(res.utc_ts)
    return instants
