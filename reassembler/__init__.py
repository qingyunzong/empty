"""File transfer gateway reassembler.

Reassembles out-of-order, overlapping and duplicated fragments keyed by
(transfer_id, epoch).  Bad fragments never pollute already verified data:
conflicting overlaps reject the whole incoming fragment and report the
minimal conflicting interval together with both fragment ids.
"""

from .fragments import Fragment
from .gateway import Gateway, GatewayConfig
from .transfer import SubmitResult, SubmitStatus

__all__ = [
    "Fragment",
    "Gateway",
    "GatewayConfig",
    "SubmitResult",
    "SubmitStatus",
]
