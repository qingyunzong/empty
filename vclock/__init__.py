"""vclock: discrete-event core (virtual clock + min-heap queue) and protocols."""

from .core import ClockError, Handle, VirtualClock
from .protocols import HeartbeatSession, StopAndWaitARQ

__all__ = [
    "ClockError",
    "Handle",
    "VirtualClock",
    "HeartbeatSession",
    "StopAndWaitARQ",
]
