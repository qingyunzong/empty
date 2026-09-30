"""Core watermark-based rolling-window aggregation.

Semantics:
  * Watermark WM = max(0, min over active srcs of their max ts) - S.
    WM is monotonic: it never moves backwards.
  * A src with no event for more than I ms of event time (relative to the
    global max ts) is idle and does not participate in the min; any new
    accepted event revives it.
  * Tumbling windows [start, end) of length W (start = floor(ts / W) * W)
    are finalised only when end <= WM.
  * Events with ts < WM - S are late: they are recorded as late and never
    correct already-finalised output.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple, Union

Number = Union[int, float]


class InputError(Exception):
    """Raised when an input line is invalid."""


@dataclass
class Event:
    src: str
    ts: int
    key: str
    val: Number

    def as_dict(self) -> dict:
        return {"src": self.src, "ts": self.ts, "key": self.key, "val": self.val}


def parse_event(line: str, lineno: int) -> Event:
    """Parse and validate one JSONL input line into an Event."""
    try:
        obj = json.loads(line)
    except json.JSONDecodeError as exc:
        raise InputError(f"line {lineno}: invalid JSON ({exc.msg})") from exc
    if not isinstance(obj, dict):
        raise InputError(f"line {lineno}: expected a JSON object")
    for name in ("src", "ts", "key", "val"):
        if name not in obj:
            raise InputError(f"line {lineno}: missing field {name!r}")
    src, ts, key, val = obj["src"], obj["ts"], obj["key"], obj["val"]
    if not isinstance(src, str) or not src:
        raise InputError(f"line {lineno}: 'src' must be a non-empty string")
    if not isinstance(key, str) or not key:
        raise InputError(f"line {lineno}: 'key' must be a non-empty string")
    if isinstance(ts, bool) or not isinstance(ts, int):
        raise InputError(f"line {lineno}: 'ts' must be an integer (ms)")
    if ts < 0:
        raise InputError(f"line {lineno}: 'ts' must be >= 0, got {ts}")
    if isinstance(val, bool) or not isinstance(val, (int, float)):
        raise InputError(f"line {lineno}: 'val' must be a number")
    return Event(src=src, ts=ts, key=key, val=val)


class WindowAggregator:
    """Streaming rolling-window per-key sum with watermarks."""

    def __init__(self, window: int, out_of_order: int, idle_timeout: int) -> None:
        if window <= 0:
            raise ValueError("window must be > 0")
        if out_of_order < 0:
            raise ValueError("out_of_order must be >= 0")
        if idle_timeout < 0:
            raise ValueError("idle_timeout must be >= 0")
        self.window = window
        self.out_of_order = out_of_order
        self.idle_timeout = idle_timeout
        self.wm: Optional[int] = None
        self._max_ts: Dict[str, int] = {}
        self._acc: Dict[Tuple[int, str], Number] = {}
        self.outputs: List[dict] = []
        self.lates: List[Event] = []

    @property
    def watermark(self) -> Optional[int]:
        return self.wm

    def process(self, ev: Event) -> None:
        # Late events are dropped from aggregation and never revive a src.
        if self.wm is not None and ev.ts < self.wm - self.out_of_order:
            self.lates.append(ev)
            return
        prev = self._max_ts.get(ev.src)
        if prev is None or ev.ts > prev:
            self._max_ts[ev.src] = ev.ts
        global_max = max(self._max_ts.values())
        active_min = min(
            m for m in self._max_ts.values() if global_max - m <= self.idle_timeout
        )
        candidate = max(0, active_min) - self.out_of_order
        if self.wm is None or candidate > self.wm:
            self.wm = candidate
        start = (ev.ts // self.window) * self.window
        acc_key = (start, ev.key)
        self._acc[acc_key] = self._acc.get(acc_key, 0) + ev.val
        self._finalize()

    def _finalize(self) -> None:
        if self.wm is None:
            return
        ready = sorted(k for k in self._acc if k[0] + self.window <= self.wm)
        for start, key in ready:
            total = self._acc.pop((start, key))
            self.outputs.append(
                {"start": start, "end": start + self.window, "key": key, "sum": total}
            )
