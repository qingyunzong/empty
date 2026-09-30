"""Discrete-event simulation core: virtual clock + min-heap event queue."""

from .core import ClockError, Handle, VirtualClock
from .protocols import HeartbeatSession, StopWaitARQ

__all__ = [
    "ClockError",
    "Handle",
    "VirtualClock",
    "HeartbeatSession",
    "StopWaitARQ",
]
