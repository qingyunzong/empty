"""retractop core: event-time tumbling-window TopK with add/retract diffs.

Semantics
---------
* Input events: {"op", "ts", "key", "score", "id"} with op in {"add", "retract"}.
* An ``add`` activates (id -> key/score@ts).  A second ``add`` with the same
  id is a duplicate and counted as invalid.
* A ``retract`` must match a *currently active* add with the same id AND the
  same key/score, otherwise it is counted as invalid (never crashes).
* An unknown op string is counted as invalid; processing continues.
* Watermark (WM) is the maximum event ts seen so far and never moves back.
* Windows are tumbling: [start, start+win) with start = (ts // win) * win.
  A window finalizes once WM >= its end; at that point its TopK diff against
  the last emitted result is emitted (``-`` rows for removals, ``+`` rows for
  additions, in rank order).
* TopK ordering: score desc, key asc, id asc.  Fewer than K live items in a
  window emits only the actual items.
* A legal late retract (or late add) landing in an already-final window emits
  a correction diff while WM <= window_end + allowed_lateness; otherwise the
  event is dropped (counted as dropped, not invalid).
* Output is a pure function of the input stream: deterministic and replayable.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

ADD = "add"
RETRACT = "retract"

Row = Tuple[Any, Any, Any]  # (key, score, id)


class ParseError(ValueError):
    """Raised when an input line is not a well-formed operation."""


@dataclass(frozen=True)
class Event:
    op: str
    ts: float
    key: str
    score: float
    id: Any


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def parse_line(line: str) -> Event:
    """Parse one JSONL line into an Event, raising ParseError on bad input."""
    try:
        obj = json.loads(line)
    except json.JSONDecodeError as exc:
        raise ParseError(f"invalid JSON: {exc}") from exc
    if not isinstance(obj, dict):
        raise ParseError("line is not a JSON object")
    for field in ("op", "ts", "key", "score", "id"):
        if field not in obj:
            raise ParseError(f"missing field {field!r}")
    op, ts, key, score, ident = (
        obj["op"],
        obj["ts"],
        obj["key"],
        obj["score"],
        obj["id"],
    )
    if not isinstance(op, str):
        raise ParseError("'op' must be a string")
    if not _is_number(ts):
        raise ParseError("'ts' must be a number")
    if not isinstance(key, str):
        raise ParseError("'key' must be a string")
    if not _is_number(score):
        raise ParseError("'score' must be a number")
    if not isinstance(ident, (str, int)) or isinstance(ident, bool):
        raise ParseError("'id' must be a string or an integer")
    return Event(op=op, ts=ts, key=key, score=score, id=ident)


def _id_sort_key(ident: Any) -> Tuple[int, Any]:
    # Deterministic total order across int/str ids: numbers before strings.
    if isinstance(ident, str):
        return (1, ident)
    return (0, ident)


class Engine:
    """Incremental TopK engine over an event stream."""

    def __init__(self, k: int, win: float, allowed_lateness: float = 0) -> None:
        if not _is_number(k) or k < 1:
            raise ValueError("k must be a positive integer")
        if not _is_number(win) or win <= 0:
            raise ValueError("win must be a positive number")
        if not _is_number(allowed_lateness) or allowed_lateness < 0:
            raise ValueError("allowed_lateness must be a non-negative number")
        self.k = int(k)
        self.win = win
        self.allowed_lateness = allowed_lateness
        self.wm: Optional[float] = None
        self.active: Dict[Any, Tuple[str, float, float]] = {}
        self.windows: Dict[float, Dict[Any, Tuple[str, float]]] = {}
        self.finalized: set = set()
        self.emitted: Dict[float, Tuple[Row, ...]] = {}
        self.out: List[Dict[str, Any]] = []
        self.invalid = 0
        self.dropped = 0

    # -- window helpers ---------------------------------------------------

    def _window_start(self, ts: float) -> float:
        return (ts // self.win) * self.win

    def _topk(self, start: float) -> Tuple[Row, ...]:
        items = self.windows.get(start)
        if not items:
            return ()
        rows = sorted(
            items.items(),
            key=lambda kv: (-kv[1][1], kv[1][0], _id_sort_key(kv[0])),
        )
        return tuple((entry[0], entry[1], ident) for ident, entry in rows[: self.k])

    def _record(self, mark: str, start: float, row: Row) -> None:
        self.out.append(
            {
                "op": mark,
                "window_end": start + self.win,
                "key": row[0],
                "score": row[1],
                "id": row[2],
            }
        )

    def _emit_if_changed(self, start: float) -> None:
        new = self._topk(start)
        old = self.emitted.get(start, ())
        if new == old:
            return
        new_set = set(new)
        old_set = set(old)
        for row in old:
            if row not in new_set:
                self._record("-", start, row)
        for row in new:
            if row not in old_set:
                self._record("+", start, row)
        self.emitted[start] = new

    def _finalize_ready(self) -> None:
        if self.wm is None:
            return
        for start in sorted(self.windows):
            if start in self.finalized:
                continue
            if start + self.win <= self.wm:
                self.finalized.add(start)
                self._emit_if_changed(start)

    def _is_final(self, start: float) -> bool:
        if start in self.finalized:
            return True
        return self.wm is not None and start + self.win <= self.wm

    def _within_lateness(self, start: float) -> bool:
        return self.wm <= start + self.win + self.allowed_lateness

    # -- event application --------------------------------------------------

    def _apply_add(self, ev: Event, start: float) -> None:
        self.active[ev.id] = (ev.key, ev.score, ev.ts)
        self.windows.setdefault(start, {})[ev.id] = (ev.key, ev.score)

    def _apply_retract(self, ident: Any, start: float) -> None:
        del self.active[ident]
        del self.windows[start][ident]

    def _add(self, ev: Event) -> None:
        if ev.id in self.active:
            self.invalid += 1
            return
        start = self._window_start(ev.ts)
        if self._is_final(start):
            if self._within_lateness(start):
                self._apply_add(ev, start)
                self._emit_if_changed(start)
            else:
                self.dropped += 1
            return
        self._apply_add(ev, start)

    def _retract(self, ev: Event) -> None:
        current = self.active.get(ev.id)
        if current is None or current[0] != ev.key or current[1] != ev.score:
            self.invalid += 1
            return
        start = self._window_start(current[2])
        if self._is_final(start):
            if self._within_lateness(start):
                self._apply_retract(ev.id, start)
                self._emit_if_changed(start)
            else:
                self.dropped += 1
            return
        self._apply_retract(ev.id, start)

    # -- public API ---------------------------------------------------------

    def process(self, ev: Event) -> None:
        if self.wm is None or ev.ts > self.wm:
            self.wm = ev.ts
        self._finalize_ready()
        if ev.op == ADD:
            self._add(ev)
        elif ev.op == RETRACT:
            self._retract(ev)
        else:
            self.invalid += 1

    def finish(self) -> None:
        """End-of-input: finalize every remaining window (WM -> +inf)."""
        for start in sorted(self.windows):
            if start not in self.finalized:
                self.finalized.add(start)
                self._emit_if_changed(start)
