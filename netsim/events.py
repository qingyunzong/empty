"""Deterministic event heap.

Event key is the tuple ``(time, seq, src, dst)``.  ``seq`` is a global
monotonically increasing counter assigned at schedule time, so events
scheduled for the same time pop in stable scheduling order.
"""
from __future__ import annotations

import heapq
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Event:
    time: float
    seq: int
    kind: str
    src: str = ""
    dst: str = ""
    data: dict = field(default_factory=dict)


class EventHeap:
    """A min-heap of events ordered by (time, seq, src, dst)."""

    def __init__(self) -> None:
        self._heap: list[tuple] = []
        self._seq = 0

    def __len__(self) -> int:
        return len(self._heap)

    @property
    def next_seq(self) -> int:
        return self._seq

    def push(self, time: float, kind: str, src: str = "", dst: str = "",
             data: dict | None = None) -> Event:
        ev = Event(time=time, seq=self._seq, kind=kind, src=src, dst=dst,
                   data=dict(data) if data else {})
        self._seq += 1
        # The ordering key is exactly (time, seq, src, dst); ``ev`` rides
        # along as a payload and is never reached by tuple comparison
        # because ``seq`` is unique.
        heapq.heappush(self._heap, (ev.time, ev.seq, ev.src, ev.dst, ev))
        return ev

    def pop(self) -> Event:
        return heapq.heappop(self._heap)[4]
