"""Watermark-based tumbling-window aggregation over JSONL event streams.

Semantics
---------
- Each event is {"src", "ts", "key", "val"} with "ts" in milliseconds.
- Watermark: WM = max(0, min(max_ts of each active src) - S), never decreases.
- A src is idle (excluded from the min) when it produced no event for more
  than I ms of event time (measured against the global max ts seen).
  A new event revives it.
- Windows are tumbling, left-closed right-open: [start, start + W).
- A window is finalised (emitted and dropped) once end <= WM.
- An event is late when ts < WM - S or its window is already finalised;
  late events are recorded in the late file and never correct emitted output.
"""
from __future__ import annotations

import json

FIELDS = ("src", "ts", "key", "val")


class EventError(ValueError):
    """Raised when an input line is not a valid event."""


def parse_event(line, lineno):
    """Parse and validate one JSONL line. Returns (src, ts, key, val)."""
    try:
        obj = json.loads(line)
    except json.JSONDecodeError as exc:
        raise EventError(f"line {lineno}: invalid JSON: {exc}") from exc
    if not isinstance(obj, dict):
        raise EventError(f"line {lineno}: event must be a JSON object")
    for field in FIELDS:
        if field not in obj:
            raise EventError(f"line {lineno}: missing field {field!r}")
    src, ts, key, val = obj["src"], obj["ts"], obj["key"], obj["val"]
    if not isinstance(src, str):
        raise EventError(f"line {lineno}: 'src' must be a string")
    if not isinstance(key, str):
        raise EventError(f"line {lineno}: 'key' must be a string")
    if isinstance(ts, bool) or not isinstance(ts, (int, float)):
        raise EventError(f"line {lineno}: 'ts' must be a number")
    if ts < 0:
        raise EventError(f"line {lineno}: 'ts' must be >= 0, got {ts}")
    if isinstance(val, bool) or not isinstance(val, (int, float)):
        raise EventError(f"line {lineno}: 'val' must be a number")
    return src, ts, key, val


class Aggregator:
    """Streaming tumbling-window per-key sum with watermarks and idleness."""

    def __init__(self, window, lateness, idle_timeout):
        if window <= 0:
            raise ValueError("window must be > 0")
        if lateness < 0:
            raise ValueError("lateness must be >= 0")
        if idle_timeout < 0:
            raise ValueError("idle_timeout must be >= 0")
        self.window = window
        self.lateness = lateness
        self.idle_timeout = idle_timeout
        self.src_max_ts = {}
        self.global_max_ts = None
        self.watermark = 0
        self.windows = {}
        self.outputs = []
        self.late = []

    @property
    def late_count(self):
        return len(self.late)

    def _active_max_ts(self):
        return [
            max_ts
            for max_ts in self.src_max_ts.values()
            if self.global_max_ts - max_ts <= self.idle_timeout
        ]

    def _advance_watermark(self):
        active = self._active_max_ts()
        if not active:
            return
        wm = max(0, min(active) - self.lateness)
        if wm > self.watermark:
            self.watermark = wm

    def add(self, src, ts, key, val):
        if self.global_max_ts is None or ts > self.global_max_ts:
            self.global_max_ts = ts
        if ts > self.src_max_ts.get(src, -1):
            self.src_max_ts[src] = ts
        self._advance_watermark()

        start = (ts // self.window) * self.window
        end = start + self.window
        if ts < self.watermark - self.lateness or end <= self.watermark:
            self.late.append({"src": src, "ts": ts, "key": key, "val": val})
        else:
            bucket = self.windows.setdefault(start, {})
            bucket[key] = bucket.get(key, 0) + val

        due = sorted(
            s for s in self.windows if s + self.window <= self.watermark
        )
        for s in due:
            agg = self.windows.pop(s)
            for key in sorted(agg):
                self.outputs.append(
                    {"start": s, "end": s + self.window, "key": key, "sum": agg[key]}
                )


def run(input_path, out_path, late_path, window, lateness, idle_timeout):
    """Process input_path and write out_path / late_path.

    Output files are written only after the whole input parsed and processed
    successfully, so a bad input never yields partial results.
    Returns the Aggregator for inspection.
    """
    agg = Aggregator(window, lateness, idle_timeout)
    with open(input_path, "r", encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, 1):
            if not line.strip():
                continue
            agg.add(*parse_event(line, lineno))

    with open(out_path, "w", encoding="utf-8") as fh:
        for rec in agg.outputs:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    with open(late_path, "w", encoding="utf-8") as fh:
        for ev in agg.late:
            fh.write(json.dumps(ev, ensure_ascii=False) + "\n")
    return agg
