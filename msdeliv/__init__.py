"""msdeliv: multi-source ordered delivery layer with cyclic sequence numbers.

Provides a per-(stream, epoch) reassembly and ordered-delivery layer with:
  - cyclic sequence numbers compared only inside an explicit window
  - fragmentation / reassembly with per-message content hashes
  - duplicate, conflicting-retransmit, old and future frame classification
  - selective ack ranges and gap retransmit requests
  - deterministic backpressure when the receive window is full
  - durable JSONL logging of receive / assemble / delivery commit points
  - crash recovery with ack-set / output-cursor consistency
"""

from .frames import Frame, message_frames
from .engine import DeliveryEngine
from .seqnum import PAST, WINDOW, AMBIGUOUS, classify, fwd_dist

__all__ = [
    "Frame",
    "message_frames",
    "DeliveryEngine",
    "PAST",
    "WINDOW",
    "AMBIGUOUS",
    "classify",
    "fwd_dist",
]
