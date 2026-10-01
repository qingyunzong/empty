"""vgc: MVCC version garbage collector.

Maintains multi-versioned key/value data with snapshot isolation,
a global low_watermark (oldest active snapshot), per-key max_versions
budgets, and time-travel queries via as_of(ts).
"""

from .core import (
    GC_OK,
    GC_DEFERRED,
    SNAPSHOT_EXPIRED,
    MVCCStore,
    SnapshotExpired,
    TxnError,
)

__all__ = [
    "GC_OK",
    "GC_DEFERRED",
    "SNAPSHOT_EXPIRED",
    "MVCCStore",
    "SnapshotExpired",
    "TxnError",
]

__version__ = "0.1.0"
