"""Go-Back-N (GBN) protocol simulator: window N=4, sequence space 8."""

from .channel import Channel, InjectionRule, Packet
from .protocol import Receiver, Sender, in_window, seq_distance
from .simulator import Result, Simulator, load_trace, run_trace

__all__ = [
    "Channel",
    "InjectionRule",
    "Packet",
    "Receiver",
    "Result",
    "Sender",
    "Simulator",
    "in_window",
    "load_trace",
    "run_trace",
    "seq_distance",
]
