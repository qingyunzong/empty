"""latefix core engine: rolling windows with watermark-driven finalize and late corrections."""

from __future__ import annotations

import json
import math


class LatefixError(Exception):
    """Base error for latefix."""


class MalformedRecordError(LatefixError):
    """Input record is missing fields or has wrong types."""


def _is_number(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def _canon(key, ts, val) -> str:
    return json.dumps([key, ts, val], sort_keys=True, separators=(",", ":"))


class _WindowState:
    __slots__ = ("key", "start", "end", "total", "version", "emitted")

    def __init__(self, key, start, end):
        self.key = key
        self.start = start
        self.end = end
        self.total = 0
        self.version = 0
        self.emitted = False


class Engine:
    """Streaming engine.

    Semantics:
    - WM = max event time seen so far (never regresses).
    - A window's value is first emitted as ADD(version=1) once end <= WM.
    - A late event for an emitted window is accepted while WM <= end + late;
      it emits RETRACT(old value, old version) then ADD(new value, version+1).
    - Events arriving when WM > end + late are dropped.
    - Empty windows never emit.
    - Duplicate physical events (same key, ts, val) are idempotent.
    """

    def __init__(self, win: int, late: int):
        if not _is_number(win) or win <= 0:
            raise ValueError("win must be a positive number")
        if not _is_number(late) or late < 0:
            raise ValueError("late must be a non-negative number")
        self.win = win
        self.late = late
        self.wm = None
        self._pending = {}   # (key, start) -> _WindowState, not yet emitted
        self._emitted = {}   # (key, start) -> _WindowState, finalized
        self._seen = set()   # canonical (key, ts, val) already processed

    def _window_bounds(self, ts):
        start = math.floor(ts / self.win) * self.win
        return start, start + self.win

    def process(self, rec):
        """Process one input record; return list of output records (may be empty)."""
        try:
            key = rec["key"]
            ts = rec["ts"]
            val = rec["val"]
        except (KeyError, TypeError):
            raise MalformedRecordError(f"record must have key/ts/val: {rec!r}")
        if not _is_number(ts):
            raise MalformedRecordError(f"ts must be a number: {rec!r}")
        if not _is_number(val):
            raise MalformedRecordError(f"val must be a number: {rec!r}")

        marker = _canon(key, ts, val)
        if marker in self._seen:
            return []
        self._seen.add(marker)

        self.wm = ts if self.wm is None else max(self.wm, ts)

        out = []
        wkey = (key, self._window_bounds(ts)[0])

        state = self._emitted.get(wkey)
        if state is not None:
            # Window already finalized: correction only within lateness horizon.
            if self.wm <= state.end + self.late:
                out.append(self._record("RETRACT", state, state.total, state.version))
                state.total = state.total + val
                state.version += 1
                out.append(self._record("ADD", state, state.total, state.version))
            # else: beyond end+late -> dropped
        else:
            state = self._pending.get(wkey)
            if state is None:
                start, end = self._window_bounds(ts)
                if self.wm > end + self.late:
                    # First-ever event for this window is already too late.
                    return out
                state = _WindowState(key, start, end)
                self._pending[wkey] = state
            state.total = state.total + val

        out.extend(self._flush())
        return out

    def _flush(self):
        """Emit ADD v1 for every pending window whose end <= WM, deterministic order."""
        out = []
        ready = [s for s in self._pending.values() if s.end <= self.wm]
        for state in sorted(ready, key=lambda s: (s.end, str(s.key), s.start)):
            state.emitted = True
            state.version = 1
            out.append(self._record("ADD", state, state.total, state.version))
            del self._pending[(state.key, state.start)]
            self._emitted[(state.key, state.start)] = state
        return out

    @staticmethod
    def _record(op, state, val, version):
        return {
            "key": state.key,
            "start": state.start,
            "end": state.end,
            "op": op,
            "val": val,
            "version": version,
        }


def run(records, win, late):
    """Convenience: run the engine over an iterable of records, return all outputs."""
    engine = Engine(win, late)
    out = []
    for rec in records:
        out.extend(engine.process(rec))
    return out
