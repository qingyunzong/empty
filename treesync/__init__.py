"""treesync: one-way sync of small file trees with journaled batches."""

from .core import (
    BATCH_SIZE,
    DEFAULT_STATE_NAME,
    TEMP_SUFFIX,
    ConflictError,
    SyncError,
    compute_plan,
    scan_tree,
    sync,
)

__version__ = "0.1.0"
