"""hierosync: hierarchical directory snapshot versioning library."""

from .core import (
    EXIT_CORRUPT,
    EXIT_ERROR,
    EXIT_OK,
    CorruptError,
    HierosyncError,
    Store,
    commit,
    empty_manifest,
    hash_bytes,
    hash_dir_entries,
    in_subtree,
    scan_manifest,
)

__version__ = "0.1.0"

__all__ = [
    "EXIT_CORRUPT",
    "EXIT_ERROR",
    "EXIT_OK",
    "CorruptError",
    "HierosyncError",
    "Store",
    "commit",
    "empty_manifest",
    "hash_bytes",
    "hash_dir_entries",
    "in_subtree",
    "scan_manifest",
    "__version__",
]
