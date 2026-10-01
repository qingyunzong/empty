"""hieroll: hierarchical tumbling-window rollup with watermarks and corrections.

Semantics
---------
- Input events are ``(key, ts, delta)`` triples; ``delta`` may be negative.
- Three fixed layers of left-closed, right-open tumbling windows aligned to
  the epoch: 1m (60s) < 5m (300s) < 1h (3600s).
- Watermark ``WM = max_ts - late``. A window with ``end <= WM`` is finalized
  and emitted with ``version = 1``.
- A correction is an event with ``ts >= WM - late`` that lands in an already
  finalized window. It re-emits the whole new value of every affected
  finalized window (the leaf window and its finalized ancestors) with
  ``version + 1``. Layers whose value is unchanged (window not yet final)
  are not re-emitted.
- An event with ``ts < WM - late`` is too late: it is dropped and counted.
- Each event affects exactly one window per layer (the one containing it).
- Windows with no accepted events are never emitted.
"""

LAYERS = (("1m", 60), ("5m", 300), ("1h", 3600))

__all__ = ["HierRoll", "LAYERS"]


class HierRoll:
    """Incremental hierarchical rollup over a stream of events."""

    def __init__(self, late=0):
        if late < 0:
            raise ValueError("late must be >= 0")
        self.late = late
        self.max_ts = None
        self.dropped = 0
        # layer -> key -> window_start -> [value, count]
        self._acc = {name: {} for name, _ in LAYERS}
        # layer -> key -> window_start -> [value, version]
        self._final = {name: {} for name, _ in LAYERS}

    @property
    def watermark(self):
        if self.max_ts is None:
            return None
        return self.max_ts - self.late

    @staticmethod
    def _record(key, layer, start, size, value, version):
        return {
            "key": key,
            "layer": layer,
            "start": start,
            "end": start + size,
            "value": value,
            "version": version,
        }

    def add(self, key, ts, delta):
        """Process one event; return the list of emitted window records."""
        if self.max_ts is None or ts > self.max_ts:
            self.max_ts = ts
        wm = self.max_ts - self.late
        if ts < wm - self.late:
            self.dropped += 1
            return []
        out = []
        for name, size in LAYERS:
            start = (ts // size) * size
            finalized = self._final[name].get(key)
            if finalized is not None and start in finalized:
                rec = finalized[start]
                rec[0] += delta
                rec[1] += 1
                out.append(self._record(key, name, start, size, rec[0], rec[1]))
            else:
                windows = self._acc[name].setdefault(key, {})
                slot = windows.setdefault(start, [0, 0])
                slot[0] += delta
                slot[1] += 1
        out.extend(self._sweep())
        return out

    def _sweep(self):
        """Finalize every accumulated window whose end <= watermark."""
        wm = self.max_ts - self.late
        out = []
        for name, size in LAYERS:
            acc = self._acc[name]
            for key, windows in acc.items():
                done = [s for s in windows if s + size <= wm]
                for start in done:
                    value, _count = windows.pop(start)
                    self._final[name].setdefault(key, {})[start] = [value, 1]
                    out.append(self._record(key, name, start, size, value, 1))
        return out
