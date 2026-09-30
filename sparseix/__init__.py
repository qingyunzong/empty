"""sparseix: sparse-file segment index manager.

A target file holds data written sparsely at arbitrary offsets. A sidecar
``.idx`` file records the occupied byte ranges (segments) so that readers
can distinguish real data from holes (which read back as 0x00).
"""

from .core import (
    MAGIC,
    VERSION,
    IndexCorrupt,
    Segment,
    check,
    index_path,
    load_index,
    read,
    save_index,
    write,
)

__all__ = [
    "MAGIC",
    "VERSION",
    "IndexCorrupt",
    "Segment",
    "check",
    "index_path",
    "load_index",
    "read",
    "save_index",
    "write",
]
