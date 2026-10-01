"""billcycle: local-calendar billing recurrence expansion.

Public API:
    Rule              -- recurrence rule (see billcycle.rule)
    BusinessCalendar  -- weekend/holiday calendar
    get_zone          -- offline timezone table lookup
    expand            -- full expansion over a UTC range
    paginate          -- cursor-based forward/reverse pagination
    CursorMismatch    -- stale/foreign cursor error
    reference         -- independent day-by-day cross-check enumerator
"""
from . import reference, tztable
from .calendar import BusinessCalendar
from .engine import CursorMismatch, expand, paginate
from .rule import Rule
from .tztable import get_zone

__all__ = [
    "BusinessCalendar",
    "CursorMismatch",
    "Rule",
    "expand",
    "get_zone",
    "paginate",
    "reference",
    "tztable",
]

__version__ = "1.0.0"
