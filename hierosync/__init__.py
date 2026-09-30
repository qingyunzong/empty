"""hierosync: hierarchical directory version snapshots with subtree undo."""

from .core import (
    CorruptionError,
    UsageError,
    Store,
    commit,
    scan_tree,
    verify_nodes,
    hash_file,
    hash_dir_entries,
    EMPTY_TREE_HASH,
    EXIT_OK,
    EXIT_USAGE,
    EXIT_CORRUPTION,
)

__version__ = "0.1.0"

__all__ = [
    "CorruptionError",
    "UsageError",
    "Store",
    "commit",
    "scan_tree",
    "verify_nodes",
    "hash_file",
    "hash_dir_entries",
    "EMPTY_TREE_HASH",
    "EXIT_OK",
    "EXIT_USAGE",
    "EXIT_CORRUPTION",
    "__version__",
]
