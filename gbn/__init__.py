"""Go-Back-N (GBN) protocol simulation package."""

from .protocol import Sender, Receiver, WINDOW_SIZE, SEQ_SPACE
from .simulator import Environment, Channel, run_simulation

__all__ = [
    "Sender",
    "Receiver",
    "Environment",
    "Channel",
    "run_simulation",
    "WINDOW_SIZE",
    "SEQ_SPACE",
]
