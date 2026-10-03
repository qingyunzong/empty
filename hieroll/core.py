"""Hierarchical rolling window aggregation with watermark finalization.

Semantics
---------
- Events are ``(key, ts, delta)`` triples; ``delta`` may be positive or negative.
- Three fixed layers of epoch-aligned, left-closed right-open windows:
  1m (60s) < 5m (300s) < 1h (3600s), with 1m windows nested in 5m windows
  nested in 1h windows.
- Watermark per key: ``WM = max_ts - late``.  A window becomes final once
  its ``end <= WM`` and is emitted (version 1) if it is non-empty.
- A late correction is an event with ``ts >= WM - late`` landing in an
  already-final window.  It triggers a re-emission of the affected leaf
  window and of every ancestor window that is also final, each with the
  new whole-window sum and ``version + 1``.  Ancestors that are not final
  yet absorb the delta silently.  Layers whose value did not change are
  never re-emitted.
- Events with ``ts < WM - late`` are too late: dropped and counted.
- Empty windows are never emitted.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

LAYERS = (("1m", 60), ("5m", 300), ("1h", 3600))
_SIZE_TO_LAYER = {size: name for name, size in LAYERS}


@dataclass(frozen=True)
class WindowRecord:
    key: str
    layer: str
    start: int
    end: int
    sum: int
    version: int

    def to_dict(self) -> dict:
        return {
            "key": self.key,
            "layer": self.layer,
            "start": self.start,
            "end": self.end,
            "sum": self.sum,
            "version": self.version,
        }


class _KeyState:
    __slots__ = ("max_ts", "sums", "versions")

    def __init__(self) -> None:
        self.max_ts = None
        # window size -> {window start: running sum} (non-empty windows only)
        self.sums = {size: {} for _, size in LAYERS}
        # (window size, window start) -> last emitted version
        self.versions = {}


class HierRoll:
    """Incremental hierarchical rolling-window aggregator."""

    def __init__(self, late: float = 0) -> None:
        if late < 0:
            raise ValueError("late must be >= 0")
        self.late = late
        self._states: dict[str, _KeyState] = {}
        self.dropped = 0

    def add(self, key: str, ts: float, delta: int) -> list[WindowRecord]:
        """Feed one event; return records emitted as a consequence."""
        state = self._states.get(key)
        if state is None:
            state = self._states[key] = _KeyState()

        emitted: list[WindowRecord] = []
        if state.max_ts is None or ts > state.max_ts:
            state.max_ts = ts
            emitted.extend(self._finalize(key, state))

        wm = state.max_ts - self.late
        if ts < wm - self.late:
            self.dropped += 1
            return emitted

        for _, size in LAYERS:
            start = int(math.floor(ts / size)) * size
            bucket = state.sums[size]
            bucket[start] = bucket.get(start, 0) + delta
            if start + size <= wm:
                # Window is final: this event is a correction.  Re-emit the
                # leaf and every final ancestor; non-final ancestors are
                # updated silently above.
                emitted.append(self._emit(key, state, size, start))
        return emitted

    def close(self) -> list[WindowRecord]:
        """Flush every non-empty window not emitted yet (version 1)."""
        emitted: list[WindowRecord] = []
        for key, state in self._states.items():
            for _, size in LAYERS:
                for start in sorted(state.sums[size]):
                    if (size, start) not in state.versions:
                        emitted.append(self._emit(key, state, size, start))
        return emitted

    def _finalize(self, key: str, state: _KeyState) -> list[WindowRecord]:
        wm = state.max_ts - self.late
        emitted = []
        for _, size in LAYERS:
            for start in sorted(state.sums[size]):
                if start + size <= wm and (size, start) not in state.versions:
                    emitted.append(self._emit(key, state, size, start))
        return emitted

    def _emit(self, key: str, state: _KeyState, size: int, start: int) -> WindowRecord:
        version = state.versions.get((size, start), 0) + 1
        state.versions[(size, start)] = version
        return WindowRecord(
            key=key,
            layer=_SIZE_TO_LAYER[size],
            start=start,
            end=start + size,
            sum=state.sums[size][start],
            version=version,
        )
