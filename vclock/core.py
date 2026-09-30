"""Virtual clock (integer ticks) and min-heap event queue.

Semantics:
- Same-tick events run in ascending priority; ties break by registration order.
- Callbacks may schedule new events for the current tick; they run within
  the current tick.
- cancel() on an executed or unknown handle returns False, never raises.
- The clock only moves forward; scheduling in the past raises ClockError.
"""

from __future__ import annotations

import heapq
import itertools
from typing import Callable, Optional


class ClockError(Exception):
    """Raised on illegal clock operations (e.g. scheduling in the past)."""


class Handle:
    """Opaque event handle returned by VirtualClock.schedule()."""

    __slots__ = ("_id",)

    def __init__(self, handle_id: int):
        self._id = handle_id

    @property
    def id(self) -> int:
        return self._id

    def __repr__(self) -> str:
        return f"Handle({self._id})"


class _Event:
    __slots__ = ("tick", "prio", "seq", "handle_id", "name", "fn", "cancelled")

    def __init__(self, tick, prio, seq, handle_id, name, fn):
        self.tick = tick
        self.prio = prio
        self.seq = seq
        self.handle_id = handle_id
        self.name = name
        self.fn = fn
        self.cancelled = False


class VirtualClock:
    """Integer-tick virtual clock with a min-heap event queue."""

    def __init__(self):
        self._now = 0
        self._heap: list = []
        self._seq = itertools.count()
        self._handle_seq = itertools.count(1)
        self._live: dict[int, _Event] = {}
        self.trace: list[dict] = []

    @property
    def now(self) -> int:
        return self._now

    def schedule(
        self,
        tick: int,
        prio: int,
        fn: Callable[[], None],
        name: Optional[str] = None,
    ) -> Handle:
        tick = int(tick)
        if tick < self._now:
            raise ClockError(
                f"cannot schedule at tick {tick}: clock is already at {self._now}"
            )
        handle_id = next(self._handle_seq)
        event = _Event(tick, int(prio), next(self._seq), handle_id, name, fn)
        self._live[handle_id] = event
        heapq.heappush(self._heap, (event.tick, event.prio, event.seq, handle_id))
        return Handle(handle_id)

    def cancel(self, handle: Handle) -> bool:
        """Cancel a pending event. Returns False for executed/unknown handles."""
        handle_id = handle.id if isinstance(handle, Handle) else int(handle)
        event = self._live.pop(handle_id, None)
        if event is None:
            return False
        event.cancelled = True
        return True

    def log(self, record: dict) -> None:
        """Append an extra entry to the event trace (stamped with now)."""
        entry = {"tick": self._now}
        entry.update(record)
        self.trace.append(entry)

    def run_until(self, t: int) -> None:
        t = int(t)
        if t < self._now:
            raise ClockError(
                f"cannot run until {t}: clock is already at {self._now}"
            )
        heap = self._heap
        while heap:
            tick, prio, seq, handle_id = heap[0]
            if tick > t:
                break
            heapq.heappop(heap)
            event = self._live.pop(handle_id, None)
            if event is None or event.cancelled:
                continue
            self._now = tick
            self.trace.append(
                {
                    "tick": tick,
                    "prio": prio,
                    "seq": event.seq,
                    "handle": handle_id,
                    "name": event.name,
                }
            )
            event.fn()
        self._now = t
