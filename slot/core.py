"""Find common free slots for multiple people within a search window.

Semantics:
- Common free time is the complement of the union of everyone's busy
  intervals, intersected with the half-open search window [s, e).
- A feasible slot is a maximal common-free interval with length >= d.
- Slots are scored by total overlap duration with the `prefer` intervals
  (prefer intervals may overlap; overlapped time is counted only once).
  Ordering: score descending, then start ascending, then end ascending.
- If several slots tie for the best score, all of them are returned,
  canonically deduplicated and sorted by (start, end).
- If no feasible slot exists the result has status "none" (not an error).

Validation errors raise SlotError with code BAD_SLOT for d <= 0, s >= e,
or inverted intervals; malformed shapes/types raise code BAD_INPUT.
"""

BAD_SLOT = "BAD_SLOT"
BAD_INPUT = "BAD_INPUT"

__all__ = ["BAD_SLOT", "BAD_INPUT", "SlotError", "find_slots"]


class SlotError(Exception):
    """Validation failure carrying a machine-readable error code."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def _is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _validate_interval(interval, what):
    if not isinstance(interval, (list, tuple)) or len(interval) != 2:
        raise SlotError(BAD_INPUT, f"{what} interval must be a [start, end] pair")
    start, end = interval
    if not _is_number(start) or not _is_number(end):
        raise SlotError(BAD_INPUT, f"{what} interval bounds must be numbers")
    if start > end:
        raise SlotError(BAD_SLOT, f"{what} interval inverted: [{start}, {end})")
    return (start, end)


def _merge(intervals):
    """Canonical union of half-open intervals (sorted, disjoint, merged)."""
    merged = []
    for start, end in sorted(intervals):
        if merged and start <= merged[-1][1]:
            if end > merged[-1][1]:
                merged[-1][1] = end
        else:
            merged.append([start, end])
    return [tuple(span) for span in merged]


def _overlap_duration(slot, merged_intervals):
    start, end = slot
    total = 0
    for a, b in merged_intervals:
        lo = max(a, start)
        hi = min(b, end)
        if lo < hi:
            total += hi - lo
    return total


def find_slots(busy, d, window, prefer=None):
    """Return {"status": "ok"|"none", "slots": [[start, end], ...]}.

    busy: list of people, each a list of [start, end] busy intervals.
    d: required minimum slot length (> 0).
    window: [s, e) search window with s < e.
    prefer: optional list of [start, end] preferred intervals (may overlap).
    """
    if not _is_number(d):
        raise SlotError(BAD_INPUT, "duration d must be a number")
    if d <= 0:
        raise SlotError(BAD_SLOT, f"duration d must be > 0, got {d}")

    if not isinstance(window, (list, tuple)) or len(window) != 2:
        raise SlotError(BAD_INPUT, "window must be a [s, e] pair")
    s, e = window
    if not _is_number(s) or not _is_number(e):
        raise SlotError(BAD_INPUT, "window bounds must be numbers")
    if s >= e:
        raise SlotError(BAD_SLOT, f"search window must satisfy s < e, got [{s}, {e})")

    if not isinstance(busy, (list, tuple)):
        raise SlotError(BAD_INPUT, "busy must be a list of per-person interval lists")
    busy_intervals = []
    for person in busy:
        if not isinstance(person, (list, tuple)):
            raise SlotError(BAD_INPUT, "each busy entry must be a list of intervals")
        for interval in person:
            busy_intervals.append(_validate_interval(interval, "busy"))

    if prefer is None:
        prefer = []
    if not isinstance(prefer, (list, tuple)):
        raise SlotError(BAD_INPUT, "prefer must be a list of intervals")
    prefer_intervals = [_validate_interval(interval, "prefer") for interval in prefer]

    clipped = []
    for a, b in busy_intervals:
        lo, hi = max(a, s), min(b, e)
        if lo < hi:
            clipped.append((lo, hi))
    merged_busy = _merge(clipped)

    free = []
    cursor = s
    for a, b in merged_busy:
        if cursor < a:
            free.append((cursor, a))
        cursor = max(cursor, b)
    if cursor < e:
        free.append((cursor, e))

    feasible = [span for span in free if span[1] - span[0] >= d]
    if not feasible:
        return {"status": "none", "slots": []}

    merged_prefer = _merge(prefer_intervals)
    scored = [(_overlap_duration(span, merged_prefer), span) for span in feasible]
    best = max(score for score, _ in scored)

    seen = set()
    slots = []
    for span in sorted(span for score, span in scored if score == best):
        if span not in seen:
            seen.add(span)
            slots.append([span[0], span[1]])
    return {"status": "ok", "slots": slots}
