"""sparseix: sparse file region index manager.

Manages a data file whose written regions (segments) are tracked by a
sidecar .idx index file.  The index file layout is:

    magic   4s   b"SPIX"
    version u32
    count   u32
    records count * (start u64, length u64, crc32 u32)

Records are stored strictly ascending by start and never overlap.
"""

from .core import IndexCorrupt, Segment, SparseFile

__all__ = ["IndexCorrupt", "Segment", "SparseFile"]
