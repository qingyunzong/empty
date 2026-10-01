"""Core windowing logic for latefix.

Semantics
---------
Input events are ``Event(key, ts, val)`` with numeric ``val``.

* Tumbling windows of size ``win`` aligned to epoch: an event with
  timestamp ``ts`` belongs to window ``[ws, ws + win)`` with
  ``ws = (ts // win) * win``.
* The watermark ``WM`` is the maximum event timestamp seen so far and
  never moves backwards (clock regressions are ignored via ``max``).
* A window's value (sum of accepted event values) is first emitted as
  ``ADD`` with version 1 once ``end <= WM``.
* A later event for an already emitted window is a legal correction
  while ``WM <= end + late``; it makes the window emit ``RETRACT`` of
  the previously added value followed by ``ADD`` of the new value with
  an incremented version.  Events arriving when ``WM > end + late``
  are dropped (so exactly ``WM == end + late`` is still correctable,
  ``end + late + 1`` is not).
* ``RETRACT`` carries exactly the value of the window's last ``ADD``.
* Empty windows never emit anything.
* The same physical event (same ``key``, ``ts`` and ``val``) arriving
  more than once is idempotent: duplicates are ignored.

When several windows become emittable after the same event, they are
emitted in canonical ``(win_start, key)`` order.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple, Union

Number = Union[int, float]

ADD = "ADD"
RETRACT = "RETRACT"


@dataclass(frozen=True)
class Event:
    key: str
    ts: int
    val: Number


@dataclass(frozen=True)
class Record:
    key: str
    win_start: int
    win_end: int
    op: str
    val: Number
    version: int

    def to_dict(self) -> dict:
        return {
            "key": self.key,
            "win_start": self.win_start,
            "win_end": self.win_end,
            "op": self.op,
            "val": self.val,
            "version": self.version,
        }


def _window_start(ts: int, win: int) -> int:
    return (ts // win) * win


def _emit_pass(
    values: Dict[Tuple[str, int], Number],
    emitted: Dict[Tuple[str, int], Tuple[Number, int]],
    wm: int,
    win: int,
    out: List[Record],
) -> None:
    for key, ws in sorted(values, key=lambda item: (item[1], item[0])):
        we = ws + win
        if we > wm:
            continue
        current = values[(key, ws)]
        previous = emitted.get((key, ws))
        if previous is None:
            emitted[(key, ws)] = (current, 1)
            out.append(Record(key, ws, we, ADD, current, 1))
        elif previous[0] != current:
            old_val, old_ver = previous
            out.append(Record(key, ws, we, RETRACT, old_val, old_ver))
            emitted[(key, ws)] = (current, old_ver + 1)
            out.append(Record(key, ws, we, ADD, current, old_ver + 1))


def run_stream(events: List[Event], win: int, late: int) -> List[Record]:
    """Incremental streaming implementation (running per-window sums)."""
    if win <= 0:
        raise ValueError("win must be positive")
    if late < 0:
        raise ValueError("late must be non-negative")
    wm: Optional[int] = None
    seen = set()
    sums: Dict[Tuple[str, int], Number] = {}
    emitted: Dict[Tuple[str, int], Tuple[Number, int]] = {}
    out: List[Record] = []
    for ev in events:
        identity = (ev.key, ev.ts, ev.val)
        if identity in seen:
            continue
        wm = ev.ts if wm is None else max(wm, ev.ts)
        ws = _window_start(ev.ts, win)
        if wm > ws + win + late:
            continue  # too late: dropped
        seen.add(identity)
        wkey = (ev.key, ws)
        sums[wkey] = sums.get(wkey, 0) + ev.val
        _emit_pass(sums, emitted, wm, win, out)
    return out


def run_reference(events: List[Event], win: int, late: int) -> List[Record]:
    """Batch-recompute reference: window values are recomputed from
    scratch from the full accepted-event history after every event."""
    if win <= 0:
        raise ValueError("win must be positive")
    if late < 0:
        raise ValueError("late must be non-negative")
    wm: Optional[int] = None
    seen = set()
    accepted: List[Event] = []
    emitted: Dict[Tuple[str, int], Tuple[Number, int]] = {}
    out: List[Record] = []
    for ev in events:
        identity = (ev.key, ev.ts, ev.val)
        if identity in seen:
            continue
        wm = ev.ts if wm is None else max(wm, ev.ts)
        ws = _window_start(ev.ts, win)
        if wm > ws + win + late:
            continue  # too late: dropped
        seen.add(identity)
        accepted.append(ev)
        values: Dict[Tuple[str, int], Number] = {}
        for past in accepted:
            pws = _window_start(past.ts, win)
            pkey = (past.key, pws)
            values[pkey] = values.get(pkey, 0) + past.val
        _emit_pass(values, emitted, wm, win, out)
    return out
