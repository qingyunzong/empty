"""Discrete-event core: virtual clock (integer ticks) + min-heap event queue."""

from __future__ import annotations

import heapq
import itertools
from dataclasses import dataclass
from typing import Callable, List, Optional, Tuple


class ClockError(Exception):
    """Raised on illegal clock operations (e.g. scheduling into the past)."""


@dataclass(frozen=True)
class Handle:
    """Opaque cancellation handle returned by VirtualClock.schedule."""

    id: int


_PENDING = "pending"
_EXECUTED = "executed"
_CANCELLED = "cancelled"


class VirtualClock:
    """A monotonic integer-tick clock driving a min-heap event queue.

    Ordering guarantees:
      1. Events fire in ascending tick order.
      2. Within one tick, events fire in ascending priority order.
      3. Within one (tick, prio) pair, events fire in registration order.
      4. A callback may schedule new events for the *current* tick; they
         are executed within the same tick (heap is drained dynamically).
    """

    def __init__(self) -> None:
        self._now = 0
        self._heap: List[Tuple[int, int, int, int, Callable[[], None]]] = []
        self._seq = itertools.count()
        self._handle_ids = itertools.count()
        self._status = {}  # handle id -> _PENDING | _EXECUTED | _CANCELLED

    @property
    def now(self) -> int:
        return self._now

    def schedule(self, tick: int, prio: int, fn: Callable[[], None]) -> Handle:
        """Schedule ``fn`` to run at ``tick`` with priority ``prio``.

        Returns a Handle usable with cancel(). Raises ClockError if ``tick``
        is in the past (the clock never moves backwards).
        """
        if isinstance(tick, bool) or not isinstance(tick, int):
            raise ClockError(f"tick must be an int, got {tick!r}")
        if isinstance(prio, bool) or not isinstance(prio, int):
            raise ClockError(f"prio must be an int, got {prio!r}")
        if not callable(fn):
            raise ClockError("fn must be callable")
        if tick < self._now:
            raise ClockError(
                f"cannot schedule at tick {tick}: clock is already at {self._now}"
            )
        handle = Handle(next(self._handle_ids))
        self._status[handle.id] = _PENDING
        heapq.heappush(self._heap, (tick, prio, next(self._seq), handle.id, fn))
        return handle

    def cancel(self, handle: object) -> bool:
        """Cancel a pending event. Returns False (never raises) if the handle
        is unknown, already executed, or already cancelled."""
        if not isinstance(handle, Handle):
            return False
        if self._status.get(handle.id) != _PENDING:
            return False
        self._status[handle.id] = _CANCELLED
        return True

    def run_until(self, t: int) -> None:
        """Advance the clock to ``t``, executing every event with tick <= t.

        Events scheduled (by callbacks) for the current tick are executed
        within this call. Raises ClockError if ``t`` is before now.
        """
        if isinstance(t, bool) or not isinstance(t, int):
            raise ClockError(f"t must be an int, got {t!r}")
        if t < self._now:
            raise ClockError(f"cannot run backwards: now={self._now}, t={t}")
        while self._heap and self._heap[0][0] <= t:
            tick, _prio, _seq, hid, fn = heapq.heappop(self._heap)
            if self._status[hid] != _PENDING:
                continue  # cancelled lazily
            self._now = tick
            self._status[hid] = _EXECUTED
            fn()
        self._now = t

    def pending(self) -> int:
        """Number of events still awaiting execution."""
        return sum(1 for s in self._status.values() if s == _PENDING)
