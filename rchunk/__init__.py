"""rchunk: content-defined chunking with verifiable .chunk indexes."""

from .core import (
    BASE,
    MASK,
    MAX_SIZE,
    MIN_SIZE,
    MOD,
    WINDOW,
    Chunker,
    RollingHash,
    chunk_stream,
)
from .index import (
    MAGIC,
    ChunkEntry,
    CorruptError,
    dumps,
    entries_from_data,
    loads,
    locate,
    verify,
)

__all__ = [
    "BASE",
    "MASK",
    "MAX_SIZE",
    "MIN_SIZE",
    "MOD",
    "WINDOW",
    "Chunker",
    "RollingHash",
    "chunk_stream",
    "MAGIC",
    "ChunkEntry",
    "CorruptError",
    "dumps",
    "entries_from_data",
    "loads",
    "locate",
    "verify",
]
