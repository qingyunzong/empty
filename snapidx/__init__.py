"""snapidx: in-memory term index with snapshots, nested transactions and
optional commit-log persistence."""

from .core import (
    SnapIdx,
    SnapIdxError,
    NoTransactionError,
    UnknownSnapshotError,
)

__all__ = [
    "SnapIdx",
    "SnapIdxError",
    "NoTransactionError",
    "UnknownSnapshotError",
]
