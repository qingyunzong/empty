"""Event-time windowed Top-K with add/retract (retraction) semantics.

Semantics
---------
* Input events: ``{"op", "ts", "key", "score", "id"}`` with
  ``op in {"add", "retract"}``.
* ``add`` inserts ``(key, score, id)`` into the tumbling event-time window
  ``[idx*win, (idx+1)*win)`` where ``idx = floor(ts / win)``.  Ids are
  single-use: any ``add`` whose id was ever added before is invalid.
* ``retract`` undoes the *active* add with the same id **and** the same
  key/score (the add may live in an earlier window).  Anything else is
  invalid.  Invalid events are counted and ignored, never fatal.
* The watermark is the max event time seen so far and never regresses.
  A window becomes final once ``watermark >= window_end``; at that point its
  Top-K diff (vs. the last emitted result for that window) is emitted, but
  only if the result actually changed.
* A valid late event touching an already-final window is applied (and a
  correction diff emitted) iff ``watermark < window_end + allowed_lateness``;
  otherwise it is dropped and counted.
* Top-K ordering: score desc, then key asc, then id asc.  Fewer than K live
  items in a window simply yields fewer rows.

Diff records look like::

    {"window_start": S, "window_end": E,
     "diff": [{"-": {"key": ..., "score": ..., "id": ...}},
              {"+": {"key": ..., "score": ..., "id": ...}}]}

``-`` rows (old rank order) are rows no longer present, ``+`` rows (new rank
order) are rows newly present.  Processing is a pure function of the input
stream, so output is deterministic and replayable.
"""

from __future__ import annotations

import json
import math

ADD = "add"
RETRACT = "retract"

_EVENT_FIELDS = ("op", "ts", "key", "score", "id")


class BadLineError(ValueError):
    """Raised when an input line cannot be parsed into a well-formed event."""


def _is_finite_number(value):
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def parse_event(line):
    """Parse one JSONL line into an event dict.

    Raises :class:`BadLineError` for malformed JSON, non-object payloads,
    missing fields, or wrongly typed fields.  Unknown ``op`` values are
    *not* rejected here; the engine counts them as invalid.
    """
    try:
        obj = json.loads(line)
    except json.JSONDecodeError as exc:
        raise BadLineError(f"invalid JSON: {exc}") from exc
    if not isinstance(obj, dict):
        raise BadLineError("event must be a JSON object")
    for name in _EVENT_FIELDS:
        if name not in obj:
            raise BadLineError(f"missing field {name!r}")
    if not isinstance(obj["op"], str):
        raise BadLineError("'op' must be a string")
    if not _is_finite_number(obj["ts"]):
        raise BadLineError("'ts' must be a finite number")
    if not isinstance(obj["key"], str):
        raise BadLineError("'key' must be a string")
    if not _is_finite_number(obj["score"]):
        raise BadLineError("'score' must be a finite number")
    if not isinstance(obj["id"], str):
        raise BadLineError("'id' must be a string")
    return {name: obj[name] for name in _EVENT_FIELDS}


def _row(key, score, ident):
    return {"key": key, "score": score, "id": ident}


class Engine:
    """Incremental event-time windowed Top-K engine."""

    def __init__(self, k, win, lateness=0):
        if not isinstance(k, int) or isinstance(k, bool) or k < 1:
            raise ValueError("k must be a positive integer")
        if not _is_finite_number(win) or win <= 0:
            raise ValueError("win must be a positive number")
        if not _is_finite_number(lateness) or lateness < 0:
            raise ValueError("lateness must be a non-negative number")
        self.k = k
        self.win = win
        self.lateness = lateness
        self.wm = None  # watermark: max ts seen so far
        self.windows = {}  # window idx -> {id: (key, score)}
        self.active = {}  # id -> (window idx, key, score)
        self.seen_ids = set()  # every id ever added (ids are single-use)
        self.emitted = {}  # window idx -> last emitted top-k rows
        self.finalized = set()  # window idx already final
        self.invalid = 0  # invalid events (bad op, dup add, bad retract)
        self.dropped = 0  # valid events dropped for exceeding allowed lateness

    def _window_idx(self, ts):
        return math.floor(ts / self.win)

    def _topk(self, idx):
        items = self.windows.get(idx, {})
        ranked = sorted(
            ((key, score, ident) for ident, (key, score) in items.items()),
            key=lambda row: (-row[1], row[0], row[2]),
        )
        return ranked[: self.k]

    def _diff(self, idx):
        """Return a diff record for window ``idx`` if its Top-K changed."""
        new = self._topk(idx)
        old = self.emitted.get(idx, [])
        if new == old:
            return None
        self.emitted[idx] = new
        changes = [{"-": _row(*row)} for row in old if row not in new]
        changes += [{"+": _row(*row)} for row in new if row not in old]
        return {
            "window_start": idx * self.win,
            "window_end": (idx + 1) * self.win,
            "diff": changes,
        }

    def _allowed(self, idx):
        """May an event still modify window ``idx``?"""
        if idx not in self.finalized:
            return True
        return self.wm < (idx + 1) * self.win + self.lateness

    def _maybe_correct(self, idx, outputs):
        """Emit a correction diff if ``idx`` is final and its result changed."""
        if idx in self.finalized:
            record = self._diff(idx)
            if record is not None:
                outputs.append(record)

    def _finalize_ready(self, outputs):
        if self.wm is None:
            return
        for idx in sorted(self.windows):
            if idx not in self.finalized and (idx + 1) * self.win <= self.wm:
                self.finalized.add(idx)
                record = self._diff(idx)
                if record is not None:
                    outputs.append(record)

    def process(self, event):
        """Apply one event; return the list of diff records it triggers."""
        outputs = []
        op = event["op"]
        ts = event["ts"]
        key = event["key"]
        score = event["score"]
        ident = event["id"]

        # Watermark never regresses.
        self.wm = ts if self.wm is None else max(self.wm, ts)

        if op == ADD:
            if ident in self.seen_ids:
                self.invalid += 1
            else:
                idx = self._window_idx(ts)
                if not self._allowed(idx):
                    self.dropped += 1
                else:
                    self.seen_ids.add(ident)
                    self.active[ident] = (idx, key, score)
                    self.windows.setdefault(idx, {})[ident] = (key, score)
                    self._maybe_correct(idx, outputs)
        elif op == RETRACT:
            match = self.active.get(ident)
            if match is None or match[1] != key or match[2] != score:
                self.invalid += 1
            else:
                idx = match[0]
                if not self._allowed(idx):
                    self.dropped += 1
                else:
                    del self.active[ident]
                    del self.windows[idx][ident]
                    self._maybe_correct(idx, outputs)
        else:
            self.invalid += 1

        self._finalize_ready(outputs)
        return outputs

    def finish(self):
        """Flush: finalize every remaining window (watermark -> infinity)."""
        outputs = []
        for idx in sorted(self.windows):
            if idx not in self.finalized:
                self.finalized.add(idx)
                record = self._diff(idx)
                if record is not None:
                    outputs.append(record)
        return outputs
